import { Router } from "express";

const router = Router();

// Gateway routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Gateway routes - implementation pending",
    gateways: []
  });
});

export { router as gatewayRoutes };