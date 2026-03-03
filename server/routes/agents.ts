import { Router } from "express";

const router = Router();

// Agent routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Agent routes - implementation pending",
    agents: []
  });
});

router.get("/outputs", async (req, res) => {
  res.json({ 
    outputs: []
  });
});

router.get("/proposals", async (req, res) => {
  res.json({ 
    proposals: []
  });
});

export { router as agentRoutes };