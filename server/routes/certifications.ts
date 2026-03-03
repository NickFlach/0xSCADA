import { Router } from "express";

const router = Router();

// Certification routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Certification routes - implementation pending",
    certifications: []
  });
});

export { router as certificationRoutes };