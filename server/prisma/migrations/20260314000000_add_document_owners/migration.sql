-- CreateTable
CREATE TABLE "document_owners" (
    "docpath" TEXT NOT NULL PRIMARY KEY,
    "uploaded_by_user_id" INTEGER,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
