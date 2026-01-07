/**
 * Agent Dashboard Page
 * 
 * PRD Section 8.2: Agent Views
 * - Agent activity feed
 * - Proposed actions
 * - Confidence / rationale
 * - Approval workflows
 */

import { Navbar } from "@/components/layout/Navbar";
import { Bot, Activity, CheckCircle, XCircle, Clock, AlertTriangle, Brain, Shield, Wrench } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";

// =============================================================================
// TYPES
// =============================================================================

interface Agent {
  id: string;
  name: string;
  displayName: string;
  agentType: string;
  status: string;
  capabilities: string[];
  lastActiveAt?: string;
  errorCount: number;
}

interface AgentOutput {
  id: string;
  agentId: string;
  outputType: string;
  title: string;
  content: unknown;
  confidence?: number;
  reasoning?: string;
  requiresApproval: boolean;
  approvalStatus?: string;
  createdAt: string;
}

interface AgentProposal {
  id: string;
  agentId: string;
  proposalType: string;
  title: string;
  description: string;
  reasoning: string;
  confidence: number;
  riskLevel: string;
  status: string;
  requiredApprovals: number;
  approvals: Array<{ userId: string; decision: string }>;
  createdAt: string;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

async function fetchAgentOutputs(): Promise<AgentOutput[]> {
  const res = await fetch("/api/agent-outputs");
  if (!res.ok) throw new Error("Failed to fetch outputs");
  return res.json();
}

async function fetchAgentProposals(): Promise<AgentProposal[]> {
  const res = await fetch("/api/agent-proposals");
  if (!res.ok) throw new Error("Failed to fetch proposals");
  return res.json();
}

// =============================================================================
// AGENT TYPE ICONS
// =============================================================================

const agentTypeIcons: Record<string, typeof Bot> = {
  OPS: Activity,
  CHANGE_CONTROL: Wrench,
  COMPLIANCE: Shield,
  SAFETY_OBSERVER: AlertTriangle,
  CODEGEN: Brain,
  CUSTOM: Bot,
};

// =============================================================================
// COMPONENTS
// =============================================================================

function AgentCard({ agent }: { agent: Agent }) {
  const Icon = agentTypeIcons[agent.agentType] || Bot;
  const isActive = agent.status === "ACTIVE";

  return (
    <Card className="border-white/10 bg-white/5 hover:bg-white/10 transition-colors">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded ${isActive ? "bg-primary/20" : "bg-white/10"}`}>
              <Icon className={`w-5 h-5 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
            </div>
            <div>
              <CardTitle className="text-base">{agent.displayName}</CardTitle>
              <CardDescription className="text-xs">{agent.agentType}</CardDescription>
            </div>
          </div>
          <Badge variant={isActive ? "default" : "secondary"} className="uppercase text-[10px]">
            {agent.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.slice(0, 4).map((cap) => (
              <span
                key={cap}
                className="text-[9px] px-1.5 py-0.5 bg-white/5 border border-white/10 rounded"
              >
                {cap.replace(/_/g, " ")}
              </span>
            ))}
            {agent.capabilities.length > 4 && (
              <span className="text-[9px] px-1.5 py-0.5 text-muted-foreground">
                +{agent.capabilities.length - 4} more
              </span>
            )}
          </div>
          {agent.lastActiveAt && (
            <div className="text-xs text-muted-foreground">
              Last active: {new Date(agent.lastActiveAt).toLocaleString()}
            </div>
          )}
          {agent.errorCount > 0 && (
            <div className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              {agent.errorCount} errors
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ProposalCard({ proposal }: { proposal: AgentProposal }) {
  const riskColors: Record<string, string> = {
    LOW: "text-green-500 border-green-500/30 bg-green-500/10",
    MEDIUM: "text-yellow-500 border-yellow-500/30 bg-yellow-500/10",
    HIGH: "text-orange-500 border-orange-500/30 bg-orange-500/10",
    CRITICAL: "text-destructive border-destructive/30 bg-destructive/10",
  };

  const statusIcons: Record<string, typeof Clock> = {
    PENDING_APPROVAL: Clock,
    APPROVED: CheckCircle,
    REJECTED: XCircle,
    EXECUTED: CheckCircle,
  };

  const StatusIcon = statusIcons[proposal.status] || Clock;
  const approvalProgress = (proposal.approvals.length / proposal.requiredApprovals) * 100;

  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusIcon
              className={`w-4 h-4 ${
                proposal.status === "APPROVED" || proposal.status === "EXECUTED"
                  ? "text-primary"
                  : proposal.status === "REJECTED"
                  ? "text-destructive"
                  : "text-yellow-500"
              }`}
            />
            <CardTitle className="text-sm">{proposal.title}</CardTitle>
          </div>
          <span
            className={`text-[10px] px-2 py-0.5 border uppercase font-bold ${
              riskColors[proposal.riskLevel]
            }`}
          >
            {proposal.riskLevel} RISK
          </span>
        </div>
        <CardDescription className="text-xs">{proposal.proposalType}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{proposal.description}</p>

        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>Confidence</span>
            <span className="text-primary">{proposal.confidence}%</span>
          </div>
          <Progress value={proposal.confidence} className="h-1" />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>Approvals</span>
            <span>
              {proposal.approvals.length} / {proposal.requiredApprovals}
            </span>
          </div>
          <Progress value={approvalProgress} className="h-1" />
        </div>

        <div className="p-2 bg-black/40 rounded text-xs">
          <span className="text-muted-foreground">Reasoning: </span>
          {proposal.reasoning}
        </div>

        {proposal.status === "PENDING_APPROVAL" && (
          <div className="flex gap-2 pt-2">
            <Button size="sm" className="flex-1">
              <CheckCircle className="w-3 h-3 mr-1" />
              Approve
            </Button>
            <Button size="sm" variant="destructive" className="flex-1">
              <XCircle className="w-3 h-3 mr-1" />
              Reject
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OutputCard({ output }: { output: AgentOutput }) {
  const typeIcons: Record<string, typeof Activity> = {
    SUMMARY: Activity,
    REPORT: Shield,
    ANALYSIS: Brain,
    ALERT: AlertTriangle,
  };

  const Icon = typeIcons[output.outputType] || Activity;

  return (
    <div className="flex gap-4 p-4 border-b border-white/5 hover:bg-white/5 transition-colors">
      <div className="p-2 bg-primary/10 rounded h-fit">
        <Icon className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-bold text-sm">{output.title}</span>
          <Badge variant="outline" className="text-[9px]">
            {output.outputType}
          </Badge>
          {output.requiresApproval && (
            <Badge variant="secondary" className="text-[9px]">
              NEEDS APPROVAL
            </Badge>
          )}
        </div>
        {output.reasoning && (
          <p className="text-xs text-muted-foreground mb-2">{output.reasoning}</p>
        )}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{new Date(output.createdAt).toLocaleString()}</span>
          {output.confidence !== undefined && (
            <span className="text-primary">{output.confidence}% confidence</span>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function AgentsPage() {
  const { data: agents = [], isLoading: agentsLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    refetchInterval: 5000,
  });

  const { data: proposals = [], isLoading: proposalsLoading } = useQuery({
    queryKey: ["agent-proposals"],
    queryFn: fetchAgentProposals,
    refetchInterval: 5000,
  });

  const { data: outputs = [], isLoading: outputsLoading } = useQuery({
    queryKey: ["agent-outputs"],
    queryFn: fetchAgentOutputs,
    refetchInterval: 5000,
  });

  const activeAgents = agents.filter((a) => a.status === "ACTIVE");
  const pendingProposals = proposals.filter((p) => p.status === "PENDING_APPROVAL");

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-12">
        {/* Header */}
        <div className="mb-8 flex justify-between items-end border-b border-primary/20 pb-4">
          <div>
            <h1 className="text-3xl font-heading font-bold uppercase flex items-center gap-3">
              <Bot className="w-8 h-8 text-primary" />
              Agent Dashboard
            </h1>
            <p className="text-muted-foreground text-sm">
              PRD Section 8.2: Agent activity, proposals, and approval workflows
            </p>
          </div>
          <div className="text-right hidden md:block">
            <p className="text-xs text-primary animate-pulse">
              {activeAgents.length} AGENTS ACTIVE
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card className="border-white/10 bg-white/5">
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-primary">{agents.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Total Agents</div>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5">
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-primary">{activeAgents.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Active</div>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5">
            <CardContent className="pt-6">
              <div className="text-3xl font-bold text-yellow-500">{pendingProposals.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Pending Approvals</div>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5">
            <CardContent className="pt-6">
              <div className="text-3xl font-bold">{outputs.length}</div>
              <div className="text-xs text-muted-foreground uppercase">Outputs Today</div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="agents" className="space-y-6">
          <TabsList className="bg-white/5 border border-white/10">
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="proposals">
              Proposals
              {pendingProposals.length > 0 && (
                <Badge variant="destructive" className="ml-2 text-[9px]">
                  {pendingProposals.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="activity">Activity Feed</TabsTrigger>
          </TabsList>

          {/* Agents Tab */}
          <TabsContent value="agents">
            {agentsLoading ? (
              <div className="text-center py-12 text-muted-foreground">Loading agents...</div>
            ) : agents.length === 0 ? (
              <div className="text-center py-12">
                <Bot className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground">No agents registered yet.</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Agents will appear here once initialized.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {agents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} />
                ))}
              </div>
            )}
          </TabsContent>

          {/* Proposals Tab */}
          <TabsContent value="proposals">
            {proposalsLoading ? (
              <div className="text-center py-12 text-muted-foreground">Loading proposals...</div>
            ) : proposals.length === 0 ? (
              <div className="text-center py-12">
                <CheckCircle className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground">No proposals yet.</p>
                <p className="text-xs text-muted-foreground mt-2">
                  Agent proposals will appear here for approval.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {proposals.map((proposal) => (
                  <ProposalCard key={proposal.id} proposal={proposal} />
                ))}
              </div>
            )}
          </TabsContent>

          {/* Activity Tab */}
          <TabsContent value="activity">
            <Card className="border-white/10 bg-white/5">
              <CardHeader>
                <CardTitle className="text-lg">Agent Activity Feed</CardTitle>
                <CardDescription>Recent outputs and actions from all agents</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {outputsLoading ? (
                  <div className="text-center py-12 text-muted-foreground">Loading activity...</div>
                ) : outputs.length === 0 ? (
                  <div className="text-center py-12">
                    <Activity className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                    <p className="text-muted-foreground">No activity yet.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/5">
                    {outputs.slice(0, 20).map((output) => (
                      <OutputCard key={output.id} output={output} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
