import type { Express } from "express";
import type { Server } from "http";
import authRoutes from "./routes/auth";
import doctorRoutes from "./routes/doctors";
import symptomRoutes from "./routes/symptoms";
import pairingRoutes from "./routes/pairings";
import adminRoutes from "./routes/admin";
import speechRoutes from "./routes/speech";

export async function registerRoutes(_httpServer: Server, app: Express): Promise<void> {
  app.use("/api/auth", authRoutes);
  app.use("/api/doctors", doctorRoutes);
  app.use("/api/symptom-reports", symptomRoutes);
  app.use("/api/pairings", pairingRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/speech", speechRoutes);
}
