
import { Router } from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  institutionName: z.string().trim().min(2).max(200),
  aicteId: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(500).optional(),
  password: z.string().min(12).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  password: z.string().min(1).max(128),
});

function createToken(user: { id: string; role: string }) {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is missing or too short");
  }

  return jwt.sign(
    { role: user.role },
    secret,
    {
      subject: user.id,
      expiresIn: "15m",
      issuer: "aicte-fdr-portal",
      audience: "aicte-fdr-api",
    }
  );
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid registration details",
      details: parsed.error.issues.map(issue => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const data = parsed.data;

  try {
    const passwordHash = await argon2.hash(data.password);

    const user = await prisma.$transaction(async tx => {
      const institution = await tx.institution.create({
        data: {
          name: data.institutionName,
          aicteId: data.aicteId || undefined,
          email: data.email,
          phone: data.phone || undefined,
          address: data.address || undefined,
        },
      });

      return tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          passwordHash,
          role: "INSTITUTION",
          institutionId: institution.id,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          institutionId: true,
        },
      });
    });

    return res.status(201).json({
      message: "Registration successful",
      user,
      accessToken: createToken(user),
      tokenType: "Bearer",
      expiresIn: 900,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return res.status(409).json({
        error: "An account or institution with these unique details already exists",
      });
    }

    console.error("Registration failed");
    return res.status(500).json({
      error: "Registration could not be completed",
    });
  }
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Enter a valid email and password",
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        role: true,
        active: true,
        institutionId: true,
      },
    });

    if (
      !user ||
      !user.active ||
      !(await argon2.verify(user.passwordHash, parsed.data.password))
    ) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const { passwordHash: _passwordHash, ...safeUser } = user;

    return res.json({
      message: "Login successful",
      user: safeUser,
      accessToken: createToken(user),
      tokenType: "Bearer",
      expiresIn: 900,
    });
  } catch {
    console.error("Login failed");
    return res.status(500).json({
      error: "Login could not be completed",
    });
  }
});
