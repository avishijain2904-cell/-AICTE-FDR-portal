
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { prisma } from "../db";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: UserRole;
    institutionId: string | null;
  };
}

export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication token required",
    });
  }

  const token = authorization.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    return res.status(500).json({
      error: "Authentication service is not configured",
    });
  }

  try {
    const decoded = jwt.verify(token, secret, {
      issuer: "aicte-fdr-portal",
      audience: "aicte-fdr-api",
    });

    if (
      typeof decoded === "string" ||
      !decoded.sub ||
      typeof decoded.role !== "string"
    ) {
      return res.status(401).json({
        error: "Invalid authentication token",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        role: true,
        active: true,
        institutionId: true,
      },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: "User account is unavailable",
      });
    }

    req.user = {
      id: user.id,
      role: user.role,
      institutionId: user.institutionId,
    };

    return next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired authentication token",
    });
  }
}

export function allowRoles(...roles: UserRole[]) {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "You do not have permission to access this resource",
      });
    }

    return next();
  };
}
