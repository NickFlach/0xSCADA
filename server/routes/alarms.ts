import { Router } from "express";
import { PhiAlertingService } from "../services/geometry/phi-alerting";
import { getFluxPublisher } from "../services/flux";

const router = Router();

// Lazy-init phi alerting
let _phiAlerting: PhiAlertingService | null = null;
function getPhiAlerting(): PhiAlertingService {
  if (!_phiAlerting) {
    _phiAlerting = new PhiAlertingService(getFluxPublisher());
    _phiAlerting.start();
  }
  return _phiAlerting;
}

// Alarm routes
router.get("/", async (req, res) => {
  const phiAlarms = getPhiAlerting().getActiveAlarms();
  res.json({ 
    alarms: phiAlarms,
  });
});

// Phi-specific alarm endpoints (#333)
router.get("/phi", async (req, res) => {
  const alerting = getPhiAlerting();
  res.json({
    active: alerting.getActiveAlarms(),
    thresholds: alerting.getThresholds(),
  });
});

router.get("/phi/history", async (req, res) => {
  res.json({ history: getPhiAlerting().getHistory() });
});

router.post("/phi/check", async (req, res) => {
  const alarm = getPhiAlerting().check();
  res.json({ alarm: alarm || null, message: alarm ? "Alarm raised" : "Phi within thresholds" });
});

export { router as alarmRoutes };