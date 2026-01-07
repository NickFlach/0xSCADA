/**
 * Agent API Routes
 * 
 * PRD Section 6.3 & 8.2: Agent Framework API
 */

import { Router } from "express";
import { db } from "../db";
import { agents, agentOutputs, agentProposals, agentState } from "@shared/schema";
import { eq } from "drizzle-orm";

export const agentRoutes = Router();

// =============================================================================
// AGENTS
// =============================================================================

// GET /api/agents - List all agents
agentRoutes.get("/", async (req, res) => {
  try {
    const allAgents = await db.select().from(agents);
    res.json(allAgents);
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ error: "Failed to fetch agents" });
  }
});

// GET /api/agents/:id - Get agent by ID
agentRoutes.get("/:id", async (req, res) => {
  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.id));
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.json(agent);
  } catch (error) {
    console.error("Error fetching agent:", error);
    res.status(500).json({ error: "Failed to fetch agent" });
  }
});

// POST /api/agents - Create agent
agentRoutes.post("/", async (req, res) => {
  try {
    const [newAgent] = await db.insert(agents).values(req.body).returning();
    res.status(201).json(newAgent);
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// PATCH /api/agents/:id - Update agent
agentRoutes.patch("/:id", async (req, res) => {
  try {
    const [updated] = await db
      .update(agents)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(agents.id, req.params.id))
      .returning();
    if (!updated) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.json(updated);
  } catch (error) {
    console.error("Error updating agent:", error);
    res.status(500).json({ error: "Failed to update agent" });
  }
});

// DELETE /api/agents/:id - Delete agent
agentRoutes.delete("/:id", async (req, res) => {
  try {
    const [deleted] = await db.delete(agents).where(eq(agents.id, req.params.id)).returning();
    if (!deleted) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting agent:", error);
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

// =============================================================================
// AGENT OUTPUTS
// =============================================================================

// GET /api/agent-outputs - List all outputs
agentRoutes.get("/outputs", async (req, res) => {
  try {
    const outputs = await db.select().from(agentOutputs);
    res.json(outputs);
  } catch (error) {
    console.error("Error fetching outputs:", error);
    res.status(500).json({ error: "Failed to fetch outputs" });
  }
});

// GET /api/agent-outputs/:agentId - Get outputs by agent
agentRoutes.get("/:agentId/outputs", async (req, res) => {
  try {
    const outputs = await db
      .select()
      .from(agentOutputs)
      .where(eq(agentOutputs.agentId, req.params.agentId));
    res.json(outputs);
  } catch (error) {
    console.error("Error fetching agent outputs:", error);
    res.status(500).json({ error: "Failed to fetch agent outputs" });
  }
});

// POST /api/agents/:agentId/outputs - Create output
agentRoutes.post("/:agentId/outputs", async (req, res) => {
  try {
    const [output] = await db
      .insert(agentOutputs)
      .values({ ...req.body, agentId: req.params.agentId })
      .returning();
    res.status(201).json(output);
  } catch (error) {
    console.error("Error creating output:", error);
    res.status(500).json({ error: "Failed to create output" });
  }
});

// =============================================================================
// AGENT PROPOSALS
// =============================================================================

// GET /api/agent-proposals - List all proposals
agentRoutes.get("/proposals", async (req, res) => {
  try {
    const proposals = await db.select().from(agentProposals);
    res.json(proposals);
  } catch (error) {
    console.error("Error fetching proposals:", error);
    res.status(500).json({ error: "Failed to fetch proposals" });
  }
});

// GET /api/agents/:agentId/proposals - Get proposals by agent
agentRoutes.get("/:agentId/proposals", async (req, res) => {
  try {
    const proposals = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.agentId, req.params.agentId));
    res.json(proposals);
  } catch (error) {
    console.error("Error fetching agent proposals:", error);
    res.status(500).json({ error: "Failed to fetch agent proposals" });
  }
});

// POST /api/agents/:agentId/proposals - Create proposal
agentRoutes.post("/:agentId/proposals", async (req, res) => {
  try {
    const [proposal] = await db
      .insert(agentProposals)
      .values({ ...req.body, agentId: req.params.agentId })
      .returning();
    res.status(201).json(proposal);
  } catch (error) {
    console.error("Error creating proposal:", error);
    res.status(500).json({ error: "Failed to create proposal" });
  }
});

// POST /api/agent-proposals/:id/approve - Approve proposal
agentRoutes.post("/proposals/:id/approve", async (req, res) => {
  try {
    const [proposal] = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, req.params.id));
    
    if (!proposal) {
      return res.status(404).json({ error: "Proposal not found" });
    }

    const { userId, userName, comment, signature } = req.body;
    const approvals = (proposal.approvals as any[]) || [];
    
    // Add approval
    approvals.push({
      userId,
      userName,
      decision: "APPROVE",
      comment,
      signature,
      decidedAt: new Date().toISOString(),
    });

    // Check if fully approved
    const newStatus = approvals.length >= proposal.requiredApprovals 
      ? "APPROVED" 
      : "PENDING_APPROVAL";

    const [updated] = await db
      .update(agentProposals)
      .set({ approvals, status: newStatus })
      .where(eq(agentProposals.id, req.params.id))
      .returning();

    res.json(updated);
  } catch (error) {
    console.error("Error approving proposal:", error);
    res.status(500).json({ error: "Failed to approve proposal" });
  }
});

// POST /api/agent-proposals/:id/reject - Reject proposal
agentRoutes.post("/proposals/:id/reject", async (req, res) => {
  try {
    const { userId, userName, comment, signature } = req.body;

    const [proposal] = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, req.params.id));
    
    if (!proposal) {
      return res.status(404).json({ error: "Proposal not found" });
    }

    const approvals = (proposal.approvals as any[]) || [];
    approvals.push({
      userId,
      userName,
      decision: "REJECT",
      comment,
      signature,
      decidedAt: new Date().toISOString(),
    });

    const [updated] = await db
      .update(agentProposals)
      .set({ approvals, status: "REJECTED" })
      .where(eq(agentProposals.id, req.params.id))
      .returning();

    res.json(updated);
  } catch (error) {
    console.error("Error rejecting proposal:", error);
    res.status(500).json({ error: "Failed to reject proposal" });
  }
});

// =============================================================================
// AGENT STATE
// =============================================================================

// GET /api/agents/:agentId/state - Get agent state
agentRoutes.get("/:agentId/state", async (req, res) => {
  try {
    const state = await db
      .select()
      .from(agentState)
      .where(eq(agentState.agentId, req.params.agentId));
    res.json(state);
  } catch (error) {
    console.error("Error fetching agent state:", error);
    res.status(500).json({ error: "Failed to fetch agent state" });
  }
});

// PUT /api/agents/:agentId/state/:key - Set state value
agentRoutes.put("/:agentId/state/:key", async (req, res) => {
  try {
    const { value, expiresAt } = req.body;
    
    // Upsert state
    const existing = await db
      .select()
      .from(agentState)
      .where(eq(agentState.agentId, req.params.agentId));
    
    const existingKey = existing.find(s => s.key === req.params.key);
    
    if (existingKey) {
      const [updated] = await db
        .update(agentState)
        .set({ value, expiresAt, updatedAt: new Date() })
        .where(eq(agentState.id, existingKey.id))
        .returning();
      res.json(updated);
    } else {
      const [created] = await db
        .insert(agentState)
        .values({
          agentId: req.params.agentId,
          key: req.params.key,
          value,
          expiresAt,
        })
        .returning();
      res.status(201).json(created);
    }
  } catch (error) {
    console.error("Error setting agent state:", error);
    res.status(500).json({ error: "Failed to set agent state" });
  }
});

// DELETE /api/agents/:agentId/state/:key - Delete state value
agentRoutes.delete("/:agentId/state/:key", async (req, res) => {
  try {
    const existing = await db
      .select()
      .from(agentState)
      .where(eq(agentState.agentId, req.params.agentId));
    
    const existingKey = existing.find(s => s.key === req.params.key);
    
    if (existingKey) {
      await db.delete(agentState).where(eq(agentState.id, existingKey.id));
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting agent state:", error);
    res.status(500).json({ error: "Failed to delete agent state" });
  }
});
