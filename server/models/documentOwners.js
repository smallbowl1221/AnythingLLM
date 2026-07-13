const prisma = require("../utils/prisma");
const { ROLES } = require("../utils/middleware/multiUserProtected");

const DocumentOwner = {
  /**
   * Set owner for docpath only if not already set (first uploader wins).
   * @param {string} docpath
   * @param {number} userId
   */
  setIfMissing: async function (docpath, userId) {
    if (!docpath || !userId) return;
    try {
      const existing = await prisma.document_owners.findUnique({
        where: { docpath },
      });
      if (!existing) {
        await prisma.document_owners.create({
          data: { docpath, uploaded_by_user_id: userId },
        });
      }
    } catch (e) {
      console.error(e.message);
    }
  },

  /**
   * Get allowed docpaths for user for "我的文件" visibility.
   * Admin: null (all). Manager: Set of docpaths where uploaded_by_user_id = user.id. Default: empty Set.
   * @param {{ id: number, role: string } | null} user
   * @returns {Promise<Set<string> | null>} null = all allowed, Set = only those paths
   */
  getAllowedDocpathsForUser: async function (user) {
    if (!user) return null;
    if (user.role === ROLES.admin) return null;
    if (user.role === ROLES.default) return new Set();
    if (user.role === ROLES.manager) {
      const rows = await prisma.document_owners.findMany({
        where: { uploaded_by_user_id: user.id },
        select: { docpath: true },
      });
      return new Set(rows.map((r) => r.docpath));
    }
    return new Set();
  },
};

module.exports = { DocumentOwner };
