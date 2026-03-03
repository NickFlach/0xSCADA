import { Router } from "express";

const router = Router();

// Alarm routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "Alarm routes - implementation pending",
    alarms: []
  });
});

export { router as alarmRoutes };