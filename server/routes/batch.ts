import { Router } from "express";

const router = Router();

// Batch routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Batch routes - implementation pending",
    batches: []
  });
});

export { router as batchRoutes };