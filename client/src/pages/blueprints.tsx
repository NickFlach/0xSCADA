import { Navbar } from "@/components/layout/Navbar";
import { Cpu, Box, Workflow, FileCode, Building2, Plus } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchControlModuleTypes, fetchUnitTypes, fetchPhaseTypes, fetchBlueprintsSummary, fetchVendors, createControlModuleType } from "@/lib/api";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type TabType = "cm-types" | "unit-types" | "phase-types";

export default function Blueprints() {
  const [activeTab, setActiveTab] = useState<TabType>("cm-types");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: summary } = useQuery({
    queryKey: ["blueprints-summary"],
    queryFn: fetchBlueprintsSummary,
  });

  const { data: cmTypes = [] } = useQuery({
    queryKey: ["cm-types"],
    queryFn: fetchControlModuleTypes,
  });

  const { data: unitTypes = [] } = useQuery({
    queryKey: ["unit-types"],
    queryFn: fetchUnitTypes,
  });

  const { data: phaseTypes = [] } = useQuery({
    queryKey: ["phase-types"],
    queryFn: fetchPhaseTypes,
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["vendors"],
    queryFn: fetchVendors,
  });

  const createMutation = useMutation({
    mutationFn: createControlModuleType,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cm-types"] });
      queryClient.invalidateQueries({ queryKey: ["blueprints-summary"] });
      setIsCreateOpen(false);
    },
  });

  const [formData, setFormData] = useState({
    name: "",
    vendorId: "",
    description: "",
    classification: "control_module",
    inputs: "[]",
    outputs: "[]",
  });
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = () => {
    setFormError(null);
    try {
      const parsedInputs = JSON.parse(formData.inputs);
      const parsedOutputs = JSON.parse(formData.outputs);
      
      if (!formData.name.trim()) {
        setFormError("Name is required");
        return;
      }
      
      createMutation.mutate({
        name: formData.name,
        vendorId: formData.vendorId || null,
        description: formData.description,
        classification: formData.classification,
        inputs: parsedInputs,
        outputs: parsedOutputs,
        inOuts: [],
      });
    } catch (e) {
      setFormError("Invalid JSON in inputs or outputs field. Please check the format.");
    }
  };

  const getVendorName = (vendorId: string | null) => {
    if (!vendorId) return "Generic";
    const vendor = vendors.find(v => v.id === vendorId);
    return vendor?.displayName || "Unknown";
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-12">
        <div className="mb-8 flex justify-between items-end border-b border-primary/20 pb-4">
          <div>
            <h1 className="text-3xl font-heading font-bold uppercase" data-testid="page-title">Blueprints Library</h1>
            <p className="text-muted-foreground text-sm">Control Module Types // Unit Types // Phase Types</p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-black hover:bg-primary/80" data-testid="button-create-cm">
                <Plus className="w-4 h-4 mr-2" /> New CM Type
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-background border border-primary/30">
              <DialogHeader>
                <DialogTitle className="text-primary">Create Control Module Type</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Name</Label>
                  <Input
                    data-testid="input-cm-name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="PIDController"
                  />
                </div>
                <div>
                  <Label>Vendor</Label>
                  <Select value={formData.vendorId} onValueChange={(v) => setFormData({ ...formData, vendorId: v })}>
                    <SelectTrigger data-testid="select-vendor">
                      <SelectValue placeholder="Select vendor" />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map((v) => (
                        <SelectItem key={v.id} value={v.id}>{v.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Description</Label>
                  <Textarea
                    data-testid="input-cm-description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Standard PID control module..."
                  />
                </div>
                <div>
                  <Label>Inputs (JSON array)</Label>
                  <Textarea
                    data-testid="input-cm-inputs"
                    value={formData.inputs}
                    onChange={(e) => setFormData({ ...formData, inputs: e.target.value })}
                    placeholder='[{"name": "SP", "dataType": "REAL", "comment": "Setpoint"}]'
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <Label>Outputs (JSON array)</Label>
                  <Textarea
                    data-testid="input-cm-outputs"
                    value={formData.outputs}
                    onChange={(e) => setFormData({ ...formData, outputs: e.target.value })}
                    placeholder='[{"name": "CV", "dataType": "REAL", "comment": "Control Value"}]'
                    className="font-mono text-xs"
                  />
                </div>
                {formError && (
                  <div className="text-red-500 text-sm border border-red-500/30 bg-red-500/10 p-2" data-testid="form-error">
                    {formError}
                  </div>
                )}
                <Button onClick={handleCreate} className="w-full bg-primary text-black" data-testid="button-submit-cm">
                  Create
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <StatCard label="CM Types" value={summary?.controlModuleTypes ?? 0} icon={Cpu} />
          <StatCard label="Unit Types" value={summary?.unitTypes ?? 0} icon={Box} />
          <StatCard label="Phase Types" value={summary?.phaseTypes ?? 0} icon={Workflow} />
          <StatCard label="Vendors" value={summary?.vendors ?? 0} icon={Building2} />
        </div>

        <div className="flex gap-4 mb-6 border-b border-white/10">
          <TabButton active={activeTab === "cm-types"} onClick={() => setActiveTab("cm-types")} data-testid="tab-cm-types">
            <Cpu className="w-4 h-4" /> Control Modules
          </TabButton>
          <TabButton active={activeTab === "unit-types"} onClick={() => setActiveTab("unit-types")} data-testid="tab-unit-types">
            <Box className="w-4 h-4" /> Units
          </TabButton>
          <TabButton active={activeTab === "phase-types"} onClick={() => setActiveTab("phase-types")} data-testid="tab-phase-types">
            <Workflow className="w-4 h-4" /> Phases
          </TabButton>
        </div>

        <div className="border border-white/10 bg-white/5">
          {activeTab === "cm-types" && (
            <div className="divide-y divide-white/5">
              {cmTypes.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  No control module types defined. Create one to get started.
                </div>
              ) : (
                cmTypes.map((cm) => (
                  <div key={cm.id} className="p-4 hover:bg-white/5 transition-colors" data-testid={`cm-type-${cm.id}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-3">
                          <Cpu className="w-5 h-5 text-primary" />
                          <span className="font-bold text-lg">{cm.name}</span>
                          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 border border-primary/30">
                            v{cm.version}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{cm.description || "No description"}</p>
                        <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                          <span>Vendor: {getVendorName(cm.vendorId)}</span>
                          <span>Inputs: {(cm.inputs as any[])?.length || 0}</span>
                          <span>Outputs: {(cm.outputs as any[])?.length || 0}</span>
                        </div>
                      </div>
                      <FileCode className="w-5 h-5 text-muted-foreground" />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === "unit-types" && (
            <div className="divide-y divide-white/5">
              {unitTypes.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  No unit types defined.
                </div>
              ) : (
                unitTypes.map((unit) => (
                  <div key={unit.id} className="p-4 hover:bg-white/5 transition-colors" data-testid={`unit-type-${unit.id}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-3">
                          <Box className="w-5 h-5 text-primary" />
                          <span className="font-bold text-lg">{unit.name}</span>
                          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 border border-primary/30">
                            v{unit.version}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{unit.description || "No description"}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === "phase-types" && (
            <div className="divide-y divide-white/5">
              {phaseTypes.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  No phase types defined.
                </div>
              ) : (
                phaseTypes.map((phase) => (
                  <div key={phase.id} className="p-4 hover:bg-white/5 transition-colors" data-testid={`phase-type-${phase.id}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-3">
                          <Workflow className="w-5 h-5 text-primary" />
                          <span className="font-bold text-lg">{phase.name}</span>
                          <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 border border-primary/30">
                            v{phase.version}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{phase.description || "No description"}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ElementType }) {
  return (
    <div className="border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between mb-2">
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <div className="text-3xl font-bold text-primary">{value}</div>
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
    </div>
  );
}

function TabButton({ children, active, onClick, ...props }: { children: React.ReactNode; active: boolean; onClick: () => void; [key: string]: any }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-3 text-sm uppercase font-bold transition-colors ${
        active ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
      }`}
      {...props}
    >
      {children}
    </button>
  );
}
