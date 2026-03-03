import { Router } from "express";

const router = Router();

// Asset Administration Shell (AAS) routes - placeholder implementation
router.get("/", async (req, res) => {
  res.json({ 
    message: "AAS routes - implementation pending",
    shells: []
  });
});

export { router as aasRouter };