-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('INSTITUTION', 'SCRUTINY_OFFICER', 'VERIFICATION_OFFICER', 'APPROVING_AUTHORITY', 'ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "FdrStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_SCRUTINY', 'DISCREPANCY', 'CLARIFICATION_PENDING', 'BANK_VERIFIED', 'ACTIVE', 'EXPIRING', 'MATURED', 'OVERDUE', 'RENEWED', 'RELEASE_REQUESTED', 'RELEASED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'MISMATCH', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RELEASED');

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aicteId" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "institutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FdrInstrument" (
    "id" TEXT NOT NULL,
    "fdrNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchName" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "lienInFavorOf" TEXT NOT NULL DEFAULT 'AICTE',
    "status" "FdrStatus" NOT NULL DEFAULT 'DRAFT',
    "institutionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FdrInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FdrDocument" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fdrId" TEXT NOT NULL,

    CONSTRAINT "FdrDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "declaredData" JSONB,
    "confirmedData" JSONB,
    "remarks" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "fdrId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Renewal" (
    "id" TEXT NOT NULL,
    "oldFdrId" TEXT NOT NULL,
    "newFdrId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Renewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseRequest" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "remarks" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "fdrId" TEXT NOT NULL,

    CONSTRAINT "ReleaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Institution_aicteId_key" ON "Institution"("aicteId");

-- CreateIndex
CREATE UNIQUE INDEX "Institution_email_key" ON "Institution"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "FdrInstrument_status_maturityDate_idx" ON "FdrInstrument"("status", "maturityDate");

-- CreateIndex
CREATE INDEX "FdrInstrument_institutionId_idx" ON "FdrInstrument"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "FdrInstrument_bankName_fdrNumber_key" ON "FdrInstrument"("bankName", "fdrNumber");

-- CreateIndex
CREATE INDEX "FdrDocument_fdrId_idx" ON "FdrDocument"("fdrId");

-- CreateIndex
CREATE INDEX "Verification_fdrId_status_idx" ON "Verification"("fdrId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Renewal_newFdrId_key" ON "Renewal"("newFdrId");

-- CreateIndex
CREATE INDEX "ReleaseRequest_status_requestedAt_idx" ON "ReleaseRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FdrInstrument" ADD CONSTRAINT "FdrInstrument_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FdrDocument" ADD CONSTRAINT "FdrDocument_fdrId_fkey" FOREIGN KEY ("fdrId") REFERENCES "FdrInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_fdrId_fkey" FOREIGN KEY ("fdrId") REFERENCES "FdrInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_oldFdrId_fkey" FOREIGN KEY ("oldFdrId") REFERENCES "FdrInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Renewal" ADD CONSTRAINT "Renewal_newFdrId_fkey" FOREIGN KEY ("newFdrId") REFERENCES "FdrInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseRequest" ADD CONSTRAINT "ReleaseRequest_fdrId_fkey" FOREIGN KEY ("fdrId") REFERENCES "FdrInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
