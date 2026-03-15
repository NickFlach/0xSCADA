import { Router } from "express";
import { rateLimitMiddleware } from "../middleware/api-gateway";

const router = Router();

// Rate limit for certification endpoints
const certRateLimit = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 30 });
router.use(certRateLimit);

// Certification routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Certification routes - implementation pending",
    certifications: []
  });
});

export { router as certificationRoutes };