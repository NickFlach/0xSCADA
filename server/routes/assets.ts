import { Router } from "express";

const router = Router();

// Asset routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Asset routes - implementation pending",
    assets: []
  });
});

export { router as assetRoutes };