
import { Router } from "express";
import { Prisma, FdrStatus, UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import {
  authenticateToken,
  allowRoles,
  AuthenticatedRequest,
} from "../middleware/authMiddleware";

export const fdrRouter = Router();

const createFdrSchema = z
  .object({
    fdrNumber: z.string().trim().min(1).max(100),
    bankName: z.string().trim().min(2).max(150),
    branchName: z.string().trim().max(150).optional(),
    amount: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, "Amount must be a positive monetary value")
      .refine((value) => Number(value) > 0, "Amount must be greater than zero"),
    issueDate: z.iso.date(),
    maturityDate: z.iso.date(),
    lienInFavorOf: z.string().trim().min(2).max(150).optional(),
  })
  .refine(
    (data) => data.maturityDate > data.issueDate,
    {
      message: "Maturity date must be after issue date",
      path: ["maturityDate"],
    }
  );

fdrRouter.post(
  "/",
  authenticateToken,
  allowRoles(UserRole.INSTITUTION),
  async (req: AuthenticatedRequest, res) => {
    const parsed = createFdrSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid FDR details",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    if (!req.user?.institutionId) {
      return res.status(403).json({
        error: "Your account is not linked to an institution",
      });
    }

    const data = parsed.data;

    try {
      const fdr = await prisma.fdrInstrument.create({
        data: {
          fdrNumber: data.fdrNumber,
          bankName: data.bankName,
          branchName: data.branchName || undefined,
          amount: new Prisma.Decimal(data.amount),
          issueDate: new Date(`${data.issueDate}T00:00:00.000Z`),
          maturityDate: new Date(`${data.maturityDate}T00:00:00.000Z`),
          lienInFavorOf: data.lienInFavorOf || "AICTE",
          status: FdrStatus.DRAFT,
          institutionId: req.user.institutionId,
        },
        select: {
          id: true,
          fdrNumber: true,
          bankName: true,
          branchName: true,
          amount: true,
          issueDate: true,
          maturityDate: true,
          lienInFavorOf: true,
          status: true,
          institutionId: true,
          createdAt: true,
        },
      });

      await prisma.auditLog.create({
        data: {
          action: "FDR_CREATED",
          entityType: "FdrInstrument",
          entityId: fdr.id,
          userId: req.user.id,
          after: {
            fdrNumber: fdr.fdrNumber,
            bankName: fdr.bankName,
            status: fdr.status,
          },
          ipAddress: req.ip,
        },
      });

      return res.status(201).json({
        message: "FDR created successfully as a draft",
        fdr,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return res.status(409).json({
          error: "An FDR with this bank and FDR number already exists",
        });
      }

      console.error("FDR creation failed");
      return res.status(500).json({
        error: "FDR could not be created",
      });
    }
  }
);


fdrRouter.get(
  "/",
  authenticateToken,
  allowRoles(UserRole.INSTITUTION),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user?.institutionId) {
      return res.status(403).json({
        error: "Your account is not linked to an institution",
      });
    }

    try {
      const fdrs = await prisma.fdrInstrument.findMany({
        where: {
          institutionId: req.user.institutionId,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          id: true,
          fdrNumber: true,
          bankName: true,
          branchName: true,
          amount: true,
          issueDate: true,
          maturityDate: true,
          lienInFavorOf: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return res.json({
        count: fdrs.length,
        fdrs,
      });
    } catch {
      console.error("FDR listing failed");
      return res.status(500).json({
        error: "FDR records could not be retrieved",
      });
    }
  }
);


fdrRouter.get(
  "/:id",
  authenticateToken,
  allowRoles(UserRole.INSTITUTION),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user?.institutionId) {
      return res.status(403).json({
        error: "Your account is not linked to an institution",
      });
    }

    const id = String(req.params.id);

    try {
      const fdr = await prisma.fdrInstrument.findFirst({
        where: {
          id,
          institutionId: req.user.institutionId,
        },
        select: {
          id: true,
          fdrNumber: true,
          bankName: true,
          branchName: true,
          amount: true,
          issueDate: true,
          maturityDate: true,
          lienInFavorOf: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          documents: {
            select: {
              id: true,
              fileName: true,
              version: true,
              uploadedAt: true,
            },
          },
          verifications: {
            select: {
              id: true,
              source: true,
              status: true,
              remarks: true,
              verifiedAt: true,
              createdAt: true,
            },
          },
        },
      });

      if (!fdr) {
        return res.status(404).json({
          error: "FDR record not found",
        });
      }

      return res.json({ fdr });
    } catch {
      console.error("FDR details retrieval failed");
      return res.status(500).json({
        error: "FDR details could not be retrieved",
      });
    }
  }
);


fdrRouter.post(
  "/:id/submit",
  authenticateToken,
  allowRoles(UserRole.INSTITUTION),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user?.institutionId) {
      return res.status(403).json({
        error: "Your account is not linked to an institution",
      });
    }

    const id = String(req.params.id);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fdr = await tx.fdrInstrument.findFirst({
          where: {
            id,
            institutionId: req.user!.institutionId!,
          },
          select: {
            id: true,
            fdrNumber: true,
            status: true,
          },
        });

        if (!fdr) {
          return { type: "NOT_FOUND" as const };
        }

        if (fdr.status !== FdrStatus.DRAFT) {
          return { type: "INVALID_STATUS" as const };
        }

        const updated = await tx.fdrInstrument.updateMany({
          where: {
            id: fdr.id,
            institutionId: req.user!.institutionId!,
            status: FdrStatus.DRAFT,
          },
          data: {
            status: FdrStatus.SUBMITTED,
          },
        });

        if (updated.count !== 1) {
          return { type: "INVALID_STATUS" as const };
        }

        await tx.auditLog.create({
          data: {
            action: "FDR_SUBMITTED",
            entityType: "FdrInstrument",
            entityId: fdr.id,
            userId: req.user!.id,
            before: {
              status: FdrStatus.DRAFT,
            },
            after: {
              status: FdrStatus.SUBMITTED,
            },
            ipAddress: req.ip,
          },
        });

        return { type: "SUCCESS" as const, fdr };
      });

      if (result.type === "NOT_FOUND") {
        return res.status(404).json({
          error: "FDR record not found",
        });
      }

      if (result.type === "INVALID_STATUS") {
        return res.status(409).json({
          error: "Only draft FDR records can be submitted",
        });
      }

      return res.json({
        message: "FDR submitted successfully for scrutiny",
        fdr: {
          id: result.fdr.id,
          fdrNumber: result.fdr.fdrNumber,
          status: FdrStatus.SUBMITTED,
        },
      });
    } catch {
      console.error("FDR submission failed");
      return res.status(500).json({
        error: "FDR could not be submitted",
      });
    }
  }
);


fdrRouter.get(
  "/scrutiny/queue",
  authenticateToken,
  allowRoles(UserRole.SCRUTINY_OFFICER),
  async (_req, res) => {
    try {
      const fdrs = await prisma.fdrInstrument.findMany({
        where: {
          status: {
            in: [
              FdrStatus.SUBMITTED,
              FdrStatus.UNDER_SCRUTINY,
              FdrStatus.CLARIFICATION_PENDING,
            ],
          },
        },
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          fdrNumber: true,
          bankName: true,
          branchName: true,
          amount: true,
          issueDate: true,
          maturityDate: true,
          status: true,
          createdAt: true,
          institution: {
            select: {
              id: true,
              name: true,
              aicteId: true,
            },
          },
        },
      });

      return res.json({
        count: fdrs.length,
        fdrs,
      });
    } catch {
      console.error("Scrutiny queue retrieval failed");
      return res.status(500).json({
        error: "Scrutiny queue could not be retrieved",
      });
    }
  }
);


fdrRouter.post(
  "/:id/start-review",
  authenticateToken,
  allowRoles(UserRole.SCRUTINY_OFFICER),
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fdr = await tx.fdrInstrument.findUnique({
          where: { id },
          select: {
            id: true,
            fdrNumber: true,
            status: true,
          },
        });

        if (!fdr) {
          return { type: "NOT_FOUND" as const };
        }

        if (fdr.status !== FdrStatus.SUBMITTED) {
          return { type: "INVALID_STATUS" as const };
        }

        const updated = await tx.fdrInstrument.updateMany({
          where: {
            id: fdr.id,
            status: FdrStatus.SUBMITTED,
          },
          data: {
            status: FdrStatus.UNDER_SCRUTINY,
          },
        });

        if (updated.count !== 1) {
          return { type: "INVALID_STATUS" as const };
        }

        await tx.auditLog.create({
          data: {
            action: "FDR_REVIEW_STARTED",
            entityType: "FdrInstrument",
            entityId: fdr.id,
            userId: req.user!.id,
            before: {
              status: FdrStatus.SUBMITTED,
            },
            after: {
              status: FdrStatus.UNDER_SCRUTINY,
            },
            ipAddress: req.ip,
          },
        });

        return { type: "SUCCESS" as const, fdr };
      });

      if (result.type === "NOT_FOUND") {
        return res.status(404).json({
          error: "FDR record not found",
        });
      }

      if (result.type === "INVALID_STATUS") {
        return res.status(409).json({
          error: "Only submitted FDRs can enter scrutiny",
        });
      }

      return res.json({
        message: "FDR review started successfully",
        fdr: {
          id: result.fdr.id,
          fdrNumber: result.fdr.fdrNumber,
          status: FdrStatus.UNDER_SCRUTINY,
        },
      });
    } catch {
      console.error("Starting FDR review failed");
      return res.status(500).json({
        error: "FDR review could not be started",
      });
    }
  }
);

const clarificationSchema = z.object({
  reason: z.string().trim().min(10).max(1000),
});

fdrRouter.post(
  "/:id/request-clarification",
  authenticateToken,
  allowRoles(UserRole.SCRUTINY_OFFICER),
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const parsed = clarificationSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Provide a clarification reason between 10 and 1000 characters",
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fdr = await tx.fdrInstrument.findUnique({
          where: { id },
          select: {
            id: true,
            fdrNumber: true,
            status: true,
          },
        });

        if (!fdr) {
          return { type: "NOT_FOUND" as const };
        }

        if (fdr.status !== FdrStatus.UNDER_SCRUTINY) {
          return { type: "INVALID_STATUS" as const };
        }

        const updated = await tx.fdrInstrument.updateMany({
          where: {
            id: fdr.id,
            status: FdrStatus.UNDER_SCRUTINY,
          },
          data: {
            status: FdrStatus.CLARIFICATION_PENDING,
          },
        });

        if (updated.count !== 1) {
          return { type: "INVALID_STATUS" as const };
        }

        await tx.auditLog.create({
          data: {
            action: "FDR_CLARIFICATION_REQUESTED",
            entityType: "FdrInstrument",
            entityId: fdr.id,
            userId: req.user!.id,
            before: {
              status: FdrStatus.UNDER_SCRUTINY,
            },
            after: {
              status: FdrStatus.CLARIFICATION_PENDING,
              reason: parsed.data.reason,
            },
            ipAddress: req.ip,
          },
        });

        return { type: "SUCCESS" as const, fdr };
      });

      if (result.type === "NOT_FOUND") {
        return res.status(404).json({
          error: "FDR record not found",
        });
      }

      if (result.type === "INVALID_STATUS") {
        return res.status(409).json({
          error: "Only FDRs under scrutiny can be returned for clarification",
        });
      }

      return res.json({
        message: "Clarification requested successfully",
        fdr: {
          id: result.fdr.id,
          fdrNumber: result.fdr.fdrNumber,
          status: FdrStatus.CLARIFICATION_PENDING,
        },
      });
    } catch {
      console.error("Clarification request failed");
      return res.status(500).json({
        error: "Clarification request could not be completed",
      });
    }
  }
);

const clarificationResponseSchema = z.object({
  response: z.string().trim().min(10).max(2000),
});

fdrRouter.post(
  "/:id/respond-clarification",
  authenticateToken,
  allowRoles(UserRole.INSTITUTION),
  async (req: AuthenticatedRequest, res) => {
    if (!req.user?.institutionId) {
      return res.status(403).json({
        error: "Your account is not linked to an institution",
      });
    }

    const id = String(req.params.id);
    const parsed = clarificationResponseSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Provide a response between 10 and 2000 characters",
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fdr = await tx.fdrInstrument.findFirst({
          where: {
            id,
            institutionId: req.user!.institutionId!,
          },
          select: {
            id: true,
            fdrNumber: true,
            status: true,
          },
        });

        if (!fdr) {
          return { type: "NOT_FOUND" as const };
        }

        if (fdr.status !== FdrStatus.CLARIFICATION_PENDING) {
          return { type: "INVALID_STATUS" as const };
        }

        const updated = await tx.fdrInstrument.updateMany({
          where: {
            id: fdr.id,
            institutionId: req.user!.institutionId!,
            status: FdrStatus.CLARIFICATION_PENDING,
          },
          data: {
            status: FdrStatus.SUBMITTED,
          },
        });

        if (updated.count !== 1) {
          return { type: "INVALID_STATUS" as const };
        }

        await tx.auditLog.create({
          data: {
            action: "FDR_CLARIFICATION_RESPONDED",
            entityType: "FdrInstrument",
            entityId: fdr.id,
            userId: req.user!.id,
            before: {
              status: FdrStatus.CLARIFICATION_PENDING,
            },
            after: {
              status: FdrStatus.SUBMITTED,
              response: parsed.data.response,
            },
            ipAddress: req.ip,
          },
        });

        return { type: "SUCCESS" as const, fdr };
      });

      if (result.type === "NOT_FOUND") {
        return res.status(404).json({
          error: "FDR record not found",
        });
      }

      if (result.type === "INVALID_STATUS") {
        return res.status(409).json({
          error: "This FDR is not awaiting clarification",
        });
      }

      return res.json({
        message: "Clarification response submitted successfully",
        fdr: {
          id: result.fdr.id,
          fdrNumber: result.fdr.fdrNumber,
          status: FdrStatus.SUBMITTED,
        },
      });
    } catch {
      console.error("Clarification response failed");
      return res.status(500).json({
        error: "Clarification response could not be submitted",
      });
    }
  }
);



fdrRouter.post(
  "/:id/forward-to-verification",
  authenticateToken,
  allowRoles(UserRole.SCRUTINY_OFFICER),
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const officerId = req.user!.id;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fdr = await tx.fdrInstrument.findUnique({
          where: { id },
        });

        if (!fdr) {
          throw new Error("FDR_NOT_FOUND");
        }

        if (fdr.status !== FdrStatus.UNDER_SCRUTINY) {
          throw new Error("FDR_NOT_UNDER_SCRUTINY");
        }

        const updated = await tx.fdrInstrument.updateMany({
          where: {
            id: fdr.id,
            status: FdrStatus.UNDER_SCRUTINY,
          },
          data: {
            status: FdrStatus.AWAITING_VERIFICATION,
          },
        });

        if (updated.count !== 1) {
          throw new Error("FDR_NOT_UNDER_SCRUTINY");
        }

        await tx.auditLog.create({
          data: {
            action: "FDR_FORWARDED_FOR_VERIFICATION",
            entityType: "FdrInstrument",
            entityId: id,
            user: {
              connect: { id: officerId },
            },
            before: {
              status: FdrStatus.UNDER_SCRUTINY,
            },
            after: {
              status: FdrStatus.AWAITING_VERIFICATION,
            },
            ipAddress: req.ip,
          },
        });

        return {
          id: fdr.id,
          fdrNumber: fdr.fdrNumber,
          status: FdrStatus.AWAITING_VERIFICATION,
        };
      });

      return res.json({
        message: "FDR forwarded for bank verification successfully",
        fdr: {
          id: result.id,
          fdrNumber: result.fdrNumber,
          status: result.status,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "FDR_NOT_FOUND") {
        return res.status(404).json({ error: "FDR not found" });
      }

      if (
        error instanceof Error &&
        error.message === "FDR_NOT_UNDER_SCRUTINY"
      ) {
        return res.status(409).json({
          error: "Only FDRs under scrutiny can be forwarded for verification",
        });
      }

      console.error("Failed to forward FDR for verification:", error);

      return res.status(500).json({
        error: "Failed to forward FDR for verification",
      });
    }
  }
);




fdrRouter.get(
  "/verification/queue",
  authenticateToken,
  allowRoles(UserRole.VERIFICATION_OFFICER),
  async (_req: AuthenticatedRequest, res) => {
    try {
      const fdrs = await prisma.fdrInstrument.findMany({
        where: {
          status: FdrStatus.AWAITING_VERIFICATION,
        },
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          fdrNumber: true,
          bankName: true,
          branchName: true,
          amount: true,
          issueDate: true,
          maturityDate: true,
          status: true,
          createdAt: true,
          institution: {
            select: {
              id: true,
              name: true,
              aicteId: true,
            },
          },
        },
      });

      return res.json({
        count: fdrs.length,
        fdrs,
      });
    } catch (error) {
      console.error("Verification queue retrieval failed:", error);
      return res.status(500).json({
        error: "Verification queue could not be retrieved",
      });
    }
  }
);


const verificationResultSchema = z.object({
  status: z.enum(["VERIFIED", "MISMATCH", "REJECTED"]),
  source: z.string().trim().min(2).max(200),
  remarks: z.string().trim().min(5).max(2000),
  declaredData: z.record(z.string(), z.unknown()).optional(),
  confirmedData: z.record(z.string(), z.unknown()).optional(),
});

fdrRouter.post(
  "/:id/verify",
  authenticateToken,
  allowRoles(UserRole.VERIFICATION_OFFICER),
  async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const parsed = verificationResultSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid verification details",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const { status, source, remarks, declaredData, confirmedData } =
      parsed.data;

    if (status === "VERIFIED" && !confirmedData) {
      return res.status(400).json({
        error: "Confirmed bank data is required for a verified result",
      });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fdr = await tx.fdrInstrument.findUnique({
          where: { id },
          select: {
            id: true,
            fdrNumber: true,
            status: true,
          },
        });

        if (!fdr) {
          return { type: "NOT_FOUND" as const };
        }

        if (fdr.status !== FdrStatus.AWAITING_VERIFICATION) {
          return { type: "INVALID_STATUS" as const };
        }

        const verification = await tx.verification.create({
          data: {
            fdrId: fdr.id,
            source,
            status,
            remarks,
            declaredData: declaredData === undefined
  ? undefined
  : (declaredData as Prisma.InputJsonValue),
            confirmedData: confirmedData === undefined
  ? undefined
  : (confirmedData as Prisma.InputJsonValue),
          },
        });

        const nextStatus =
          status === "VERIFIED"
            ? FdrStatus.BANK_VERIFIED
            : status === "MISMATCH"
              ? FdrStatus.DISCREPANCY
              : FdrStatus.REJECTED;

        const updated = await tx.fdrInstrument.updateMany({
          where: {
            id: fdr.id,
            status: FdrStatus.AWAITING_VERIFICATION,
          },
          data: {
            status: nextStatus,
          },
        });

        if (updated.count !== 1) {
          throw new Error("FDR_STATUS_CHANGED");
        }

        await tx.auditLog.create({
          data: {
            action: "FDR_BANK_VERIFICATION_RECORDED",
            entityType: "FdrInstrument",
            entityId: fdr.id,
            user: {
              connect: { id: req.user!.id },
            },
            before: {
              status: FdrStatus.AWAITING_VERIFICATION,
            },
            after: {
              status: nextStatus,
              verificationStatus: status,
              source,
              remarks,
            },
            ipAddress: req.ip,
          },
        });

        return {
          type: "SUCCESS" as const,
          fdrNumber: fdr.fdrNumber,
          nextStatus,
          verificationId: verification.id,
        };
      });

      if (result.type === "NOT_FOUND") {
        return res.status(404).json({ error: "FDR not found" });
      }

      if (result.type === "INVALID_STATUS") {
        return res.status(409).json({
          error: "Only FDRs awaiting verification can be verified",
        });
      }

      return res.json({
        message: "Verification result recorded successfully",
        verification: {
          id: result.verificationId,
          status,
          source,
          remarks,
        },
        fdr: {
          fdrNumber: result.fdrNumber,
          status: result.nextStatus,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "FDR_STATUS_CHANGED") {
        return res.status(409).json({
          error: "FDR status changed; refresh and retry",
        });
      }

      console.error("FDR verification failed:", error);
      return res.status(500).json({
        error: "FDR verification could not be recorded",
      });
    }
  }
);
