
import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient, UserRole } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();

const officerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(128),
  role: z.nativeEnum(UserRole),
});

async function main() {
  const parsed = officerSchema.safeParse({
    name: process.env.OFFICER_NAME,
    email: process.env.OFFICER_EMAIL,
    password: process.env.OFFICER_PASSWORD,
    role: process.env.OFFICER_ROLE,
  });

  if (!parsed.success) {
    console.error(
      "Set valid OFFICER_NAME, OFFICER_EMAIL, OFFICER_PASSWORD and OFFICER_ROLE values in your local environment."
    );
    process.exitCode = 1;
    return;
  }

  const { name, email, password, role } = parsed.data;

  if (role === UserRole.INSTITUTION) {
    console.error("This script is only for internal officer accounts.");
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    console.error("A user with this email already exists. No changes made.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      role,
      institutionId: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  });

  console.log("Officer account created successfully:", user);
}

main()
  .catch(() => {
    console.error("Could not create officer account.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
