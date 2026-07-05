-- AlterTable
ALTER TABLE "Session" ADD COLUMN "chatHistory" TEXT;

-- CreateTable
CREATE TABLE "StyleProfile" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "styleNotes" TEXT NOT NULL DEFAULT '',
    "referenceUrls" TEXT NOT NULL DEFAULT '[]',
    "topicFocus" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);
