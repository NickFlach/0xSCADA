import { Router } from "express";
import { PhiAlertingService } from "../services/geometry/phi-alerting";
import { getFluxPublisher } from "../services/flux";
import { requireControlPlaneAccess } from "../middleware/control-plane-auth";

const router = Router();
const requireAlarmWrite = requireControlPlaneAccess({
  scopes: ["alarms.write"],
});

// Phi alerting instance — must be initialized explicitly via initPhiAlerting()
let _phiAlerting: PhiAlertingService | null = null;

/** Call this at server startup to initialize phi alerting (not on first GET) */
export function initPhiAlerting(): PhiAlertingService {
  if (!_phiAlerting) {
    _phiAlerting = new PhiAlertingService(getFluxPublisher());
    _phiAlerting.start();
  }
  return _phiAlerting;
}

function getPhiAlerting(): PhiAlertingService {
  if (!_phiAlerting) {
    // Return a non-started instance; callers get empty data instead of triggering timers
    _phiAlerting = new PhiAlertingService(getFluxPublisher());
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

router.post("/phi/check", requireAlarmWrite, async (_req, res) => {
  const alarm = getPhiAlerting().check();
  res.json({ alarm: alarm || null, message: alarm ? "Alarm raised" : "Phi within thresholds" });
});

export { router as alarmRoutes };
