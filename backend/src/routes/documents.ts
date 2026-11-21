import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { FdrStatus, UserRole } from "@prisma/client";
import { prisma } from "../db";
import {
  authenticateToken,
  AuthenticatedRequest,
} from "../middleware/authMiddleware";

export const documentsRouter = Router();

const storageDir = path.resolve(process.cwd(), "private_uploads/fdr");
const maxBytes = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      mkdir(storageDir, { recursive: true })
        .then(() => callback(null, storageDir))
        .catch((error) => callback(error, storageDir));
    },
    filename: (_req, _file, callback) => {
      callback(null, `${randomUUID()}.pdf`);
    },
  }),
  limits: { fileSize: maxBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "application/pdf" || !file.originalname.toLowerCase().endsWith(".pdf")) {
      callback(new Error("Upload a PDF file only"));
      return;
    }
    callback(null, true);
  },
});

const reviewStatuses: FdrStatus[] = [
  FdrStatus.SUBMITTED,
  FdrStatus.UNDER_SCRUTINY,
  FdrStatus.CLARIFICATION_PENDING,
  FdrStatus.AWAITING_VERIFICATION,
  FdrStatus.BANK_VERIFIED,
  FdrStatus.DISCREPANCY,
  FdrStatus.REJECTED,
];

documentsRouter.post(
  "/:id/documents",
  authenticateToken,
  upload.single("fdrPdf"),
  async (req: AuthenticatedRequest, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Select an FDR PDF to upload" });
    }

    try {
      const id = String(req.params.id);
      const fdr = await prisma.fdrInstrument.findUnique({
        where: { id },
        select: { id: true, institutionId: true, status: true, fdrNumber: true },
      });

      if (!fdr) {
        await unlink(file.path).catch(() => {});
        return res.status(404).json({ error: "FDR record not found" });
      }

      const role = req.user!.role;
      const isOwner =
        role === UserRole.INSTITUTION &&
        !!req.user!.institutionId &&
        req.user!.institutionId === fdr.institutionId;

      if (!isOwner || fdr.status !== FdrStatus.DRAFT) {
        await unlink(file.path).catch(() => {});
        return res.status(403).json({
          error: "Only the owning institution can attach a PDF to its draft FDR",
        });
      }

      const bytes = await readFile(file.path);
      if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        await unlink(file.path).catch(() => {});
        return res.status(400).json({ error: "The selected file is not a valid PDF" });
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const document = await prisma.fdrDocument.create({
        data: {
          fileName: path.basename(file.originalname).slice(0, 255),
          storageKey: file.filename,
          sha256,
          fdrId: fdr.id,
        },
        select: { id: true, fileName: true, version: true, uploadedAt: true },
      });

      await prisma.auditLog.create({
        data: {
          action: "FDR_PDF_UPLOADED",
          entityType: "FdrDocument",
          entityId: document.id,
          userId: req.user!.id,
          after: { fdrId: fdr.id, fdrNumber: fdr.fdrNumber, sha256 },
          ipAddress: req.ip,
        },
      });

      return res.status(201).json({ message: "FDR PDF uploaded", document });
    } catch (error) {
      await unlink(file.path).catch(() => {});
      console.error("FDR PDF upload failed:", error);
      return res.status(500).json({ error: "FDR PDF could not be saved" });
    }
  }
);

documentsRouter.get(
  "/documents/:documentId/file",
  authenticateToken,
  async (req: AuthenticatedRequest, res) => {
    try {
      const document = await prisma.fdrDocument.findUnique({
        where: { id: String(req.params.documentId) },
        include: {
          fdr: {
            select: { id: true, institutionId: true, status: true, fdrNumber: true },
          },
        },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const role = req.user!.role;
      const institutionOwns =
        role === UserRole.INSTITUTION &&
        !!req.user!.institutionId &&
        req.user!.institutionId === document.fdr.institutionId;

      const scrutinyCanView =
        role === UserRole.SCRUTINY_OFFICER &&
        reviewStatuses.includes(document.fdr.status);

      const verificationStatuses: FdrStatus[] = [
        FdrStatus.AWAITING_VERIFICATION,
        FdrStatus.BANK_VERIFIED,
        FdrStatus.DISCREPANCY,
        FdrStatus.REJECTED,
      ];

      const verificationCanView =
        role === UserRole.VERIFICATION_OFFICER &&
        verificationStatuses.includes(document.fdr.status);

      if (!institutionOwns && !scrutinyCanView && !verificationCanView) {
        return res.status(403).json({ error: "You cannot access this FDR document" });
      }

      const safeKey = path.basename(document.storageKey);
      if (safeKey !== document.storageKey || !safeKey.endsWith(".pdf")) {
        return res.status(500).json({ error: "Invalid document storage reference" });
      }

      const filePath = path.join(storageDir, safeKey);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="FDR-${document.fdr.fdrNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      return res.sendFile(filePath, (error) => {
        if (error && !res.headersSent) {
          res.status(500).json({
            error: "Stored PDF could not be opened",
          });
        }
      });
    } catch (error) {
      console.error("FDR PDF retrieval failed:", error);
      return res.status(500).json({ error: "FDR PDF could not be retrieved" });
    }
  }
);
