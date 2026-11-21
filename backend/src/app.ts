
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { prisma } from "./db";
import path from "node:path";
import { documentsRouter } from "./routes/documents";
import { authRouter } from "./routes/auth";
import {
  authenticateToken,
  AuthenticatedRequest,
} from "./middleware/authMiddleware";
import { fdrRouter } from "./routes/fdr";

export const app = express();
app.use(express.static(path.join(process.cwd(), "public")));
app.use("/api/fdrs", documentsRouter);
app.use(helmet());
app.use(
  cors({
    origin: "http://localhost:4000",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.get(
  "/api/auth/me",
  authenticateToken,
  (req: AuthenticatedRequest, res) => {
    res.json({
      message: "Authentication successful",
      user: req.user,
    });
  }
);
app.use("/api/fdrs", fdrRouter);

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "ok",
      database: "connected",
      service: "AICTE FDR Portal API",
    });
  } catch {
    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});
