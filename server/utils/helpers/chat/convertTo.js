// Helpers that convert workspace chats to some supported format
// for external use by the user.

const { WorkspaceChats } = require("../../../models/workspaceChats");
const { EmbedChats } = require("../../../models/embedChats");
const { safeJsonParse } = require("../../http");
const { SystemSettings } = require("../../../models/systemSettings");

async function convertToCSV(preparedData) {
  const headers = new Set(["id", "workspace", "prompt", "response", "sent_at"]);
  preparedData.forEach((item) =>
    Object.keys(item).forEach((key) => headers.add(key))
  );

  const rows = [Array.from(headers).join(",")];

  for (const item of preparedData) {
    const record = Array.from(headers)
      .map((header) => {
        const value = item[header] ?? "";
        return escapeCsv(String(value));
      })
      .join(",");
    rows.push(record);
  }
  return rows.join("\n");
}

async function convertToJSON(preparedData) {
  if (preparedData.length === 0) return Buffer.from("[]");

  const chunks = [];
  chunks.push(Buffer.from("[\n"));
  for (let i = 0; i < preparedData.length; i++) {
    const isLast = i === preparedData.length - 1;
    const itemStr =
      "    " +
      JSON.stringify(preparedData[i], null, 4).replace(/\n/g, "\n    ") +
      (isLast ? "\n" : ",\n");
    chunks.push(Buffer.from(itemStr));
  }
  chunks.push(Buffer.from("]"));
  return Buffer.concat(chunks);
}

// ref: https://raw.githubusercontent.com/gururise/AlpacaDataCleaned/main/alpaca_data.json
async function convertToJSONAlpaca(preparedData) {
  if (preparedData.length === 0) return Buffer.from("[]");

  const chunks = [];
  chunks.push(Buffer.from("[\n"));
  for (let i = 0; i < preparedData.length; i++) {
    const isLast = i === preparedData.length - 1;
    const itemStr =
      "    " +
      JSON.stringify(preparedData[i], null, 4).replace(/\n/g, "\n    ") +
      (isLast ? "\n" : ",\n");
    chunks.push(Buffer.from(itemStr));
  }
  chunks.push(Buffer.from("]"));
  return Buffer.concat(chunks);
}

// You can validate JSONL outputs on https://jsonlines.org/validator/
async function convertToJSONL(workspaceChatsMap) {
  const values = Object.values(workspaceChatsMap);
  if (values.length === 0) return Buffer.from("");

  const chunks = [];
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    chunks.push(Buffer.from('{"messages":['));
    for (let j = 0; j < item.messages.length; j++) {
      const msgStr = JSON.stringify(item.messages[j]);
      chunks.push(Buffer.from(msgStr + (j === item.messages.length - 1 ? "" : ",")));
    }
    chunks.push(Buffer.from(']}\n'));
  }
  return Buffer.concat(chunks);
}

async function prepareChatsForExport(format = "jsonl", chatType = "workspace", user = null) {
  if (!exportMap.hasOwnProperty(format))
    throw new Error(`Invalid export type: ${format}`);

  let chats;
  if (chatType === "workspace") {
    let clause = {};
    if (user?.role === "manager") {
      // ponytail: filter chats by workspaces assigned to this manager
      const { WorkspaceUser } = require("../../../models/workspaceUsers");
      const workspaceRelations = await WorkspaceUser.where({ user_id: user.id });
      const workspaceIds = workspaceRelations.map((rel) => rel.workspace_id);
      clause.workspaceId = { in: workspaceIds };
    }
    chats = await WorkspaceChats.whereWithData(clause, null, null, null);
  } else if (chatType === "embed") {
    chats = await EmbedChats.whereWithEmbedAndWorkspace(
      {},
      null,
      null,
      null
    );
  } else {
    throw new Error(`Invalid chat type: ${chatType}`);
  }

  if (format === "csv" || format === "json") {
    const preparedData = chats.map((chat) => {
      const responseJson = safeJsonParse(chat.response, {});
      const baseData = {
        id: chat.id,
        prompt: chat.prompt,
        response: responseJson.text,
        sent_at: chat.createdAt,
        // Only add attachments to the json format since we cannot arrange attachments in csv format
        ...(format === "json"
          ? {
              attachments:
                responseJson.attachments?.length > 0
                  ? responseJson.attachments.map((attachment) => ({
                      type: "image",
                      image: attachmentToDataUrl(attachment),
                    }))
                  : [],
            }
          : {}),
      };

      if (chatType === "embed") {
        return {
          ...baseData,
          workspace: chat.embed_config
            ? chat.embed_config.workspace.name
            : "unknown workspace",
        };
      }

      return {
        ...baseData,
        workspace: chat.workspace ? chat.workspace.name : "unknown workspace",
        username: chat.user
          ? chat.user.username
          : chat.api_session_id !== null
            ? "API"
            : "unknown user",
        rating:
          chat.feedbackScore === null
            ? "--"
            : chat.feedbackScore
              ? "GOOD"
              : "BAD",
      };
    });

    return preparedData;
  }

  // jsonAlpaca format does not support array outputs
  if (format === "jsonAlpaca") {
    const preparedData = chats.map((chat) => {
      const responseJson = safeJsonParse(chat.response, {});
      return {
        instruction: buildSystemPrompt(
          chat,
          chat.workspace ? chat.workspace.openAiPrompt : null
        ),
        input: chat.prompt,
        output: responseJson.text,
      };
    });

    return preparedData;
  }

  // Export to JSONL format (recommended for fine-tuning)
  const workspaceChatsMap = chats.reduce((acc, chat) => {
    const { prompt, response, workspaceId } = chat;
    const responseJson = safeJsonParse(response, { attachments: [] });
    const attachments = responseJson.attachments;

    if (!acc[workspaceId]) {
      acc[workspaceId] = {
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text:
                  chat.workspace?.openAiPrompt ??
                  SystemSettings.saneDefaultSystemPrompt,
              },
            ],
          },
        ],
      };
    }

    acc[workspaceId].messages.push(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          ...(attachments?.length > 0
            ? attachments.map((attachment) => ({
                type: "image",
                image: attachmentToDataUrl(attachment),
              }))
            : []),
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: responseJson.text,
          },
        ],
      }
    );

    return acc;
  }, {});

  return workspaceChatsMap;
}

const exportMap = {
  json: {
    contentType: "application/json",
    func: convertToJSON,
  },
  csv: {
    contentType: "text/csv",
    func: convertToCSV,
  },
  jsonl: {
    contentType: "application/jsonl",
    func: convertToJSONL,
  },
  jsonAlpaca: {
    contentType: "application/json",
    func: convertToJSONAlpaca,
  },
};

function escapeCsv(str) {
  if (str === null || str === undefined) return '""';
  return `"${str.replace(/"/g, '""').replace(/\n/g, " ")}"`;
}

async function exportChatsAsType(format = "jsonl", chatType = "workspace", user = null) {
  const { contentType, func } = exportMap.hasOwnProperty(format)
    ? exportMap[format]
    : exportMap.jsonl;
  const chats = await prepareChatsForExport(format, chatType, user);
  return {
    contentType,
    data: await func(chats),
  };
}

function buildSystemPrompt(chat, prompt = null) {
  const sources = safeJsonParse(chat.response)?.sources || [];
  const contextTexts = sources.map((source) => source.text);
  const context =
    sources.length > 0
      ? "\nContext:\n" +
        contextTexts
          .map((text, i) => {
            return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
          })
          .join("")
      : "";
  return `${prompt ?? SystemSettings.saneDefaultSystemPrompt}${context}`;
}

/**
 * Converts an attachment's content string to a proper data URL format if needed
 * @param {Object} attachment - The attachment object containing contentString and mime type
 * @returns {string} The properly formatted data URL
 */
function attachmentToDataUrl(attachment) {
  return attachment.contentString.startsWith("data:")
    ? attachment.contentString
    : `data:${attachment.mime};base64,${attachment.contentString}`;
}

module.exports = {
  prepareChatsForExport,
  exportChatsAsType,
};
