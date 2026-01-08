import { Navbar } from "@/components/layout/Navbar";
import { Code, Play, Anchor, Copy, Check, AlertCircle, Cpu, Settings } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchControlModuleTypes, fetchPhaseTypes, fetchVendors, generateControlModuleCode, generatePhaseCode, generateLadderLogicForControlModule, generateLadderLogicForPhase } from "@/lib/api";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type SourceType = "control_module" | "phase";
type GenerationMode = "vendor" | "ladder_logic";

export default function CodeGen() {
  const [sourceType, setSourceType] = useState<SourceType>("control_module");
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [selectedVendor, setSelectedVendor] = useState<string>("");
  const [instanceName, setInstanceName] = useState("");
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [visualDiagram, setVisualDiagram] = useState<string | null>(null);
  const [codeHash, setCodeHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("vendor");
  const [codeViewMode, setCodeViewMode] = useState<"visual" | "neutral">("visual");
  
  const [ladderOptions, setLadderOptions] = useState({
    includeComments: true,
    generateFaultHandling: true,
    generateInterlocks: true,
  });
  const [ladderMetadata, setLadderMetadata] = useState<{
    rungCount?: number;
    instructionCount?: number;
    tags?: Array<{ name: string; dataType: string; description?: string }>;
  } | null>(null);

  const { data: cmTypes = [] } = useQuery({
    queryKey: ["cm-types"],
    queryFn: fetchControlModuleTypes,
  });

  const { data: phaseTypes = [] } = useQuery({
    queryKey: ["phase-types"],
    queryFn: fetchPhaseTypes,
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["vendors"],
    queryFn: fetchVendors,
  });

  const generateVendorMutation = useMutation({
    mutationFn: async () => {
      if (sourceType === "control_module") {
        return generateControlModuleCode(selectedSource, selectedVendor, { instanceName: instanceName || undefined });
      } else {
        return generatePhaseCode(selectedSource, selectedVendor, { instanceName: instanceName || undefined });
      }
    },
    onSuccess: (result) => {
      setGeneratedCode(result.code);
      setVisualDiagram(null);
      setCodeHash(result.codeHash);
      setErrors([]);
      setLadderMetadata(null);
      setCodeViewMode("neutral");
    },
    onError: (error: Error) => {
      setErrors([error.message]);
      setGeneratedCode(null);
      setVisualDiagram(null);
      setCodeViewMode("neutral");
    },
  });

  const generateLadderMutation = useMutation({
    mutationFn: async () => {
      if (sourceType === "control_module") {
        return generateLadderLogicForControlModule(selectedSource, ladderOptions);
      } else {
        return generateLadderLogicForPhase(selectedSource, ladderOptions);
      }
    },
    onSuccess: (result) => {
      setGeneratedCode(result.code);
      setVisualDiagram(result.visualDiagram);
      setCodeHash(result.codeHash);
      setErrors([]);
      setLadderMetadata({
        rungCount: result.metadata.rungCount,
        instructionCount: result.metadata.instructionCount,
        tags: result.tags,
      });
      setCodeViewMode("visual");
    },
    onError: (error: Error) => {
      setErrors([error.message]);
      setGeneratedCode(null);
      setVisualDiagram(null);
      setLadderMetadata(null);
    },
  });

  const sources = sourceType === "control_module" ? cmTypes : phaseTypes;

  const handleCopy = () => {
    if (generatedCode) {
      navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleGenerate = () => {
    if (generationMode === "vendor") {
      generateVendorMutation.mutate();
    } else {
      generateLadderMutation.mutate();
    }
  };

  const canGenerate = selectedSource && (generationMode === "ladder_logic" || selectedVendor);
  const isPending = generateVendorMutation.isPending || generateLadderMutation.isPending;

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-12">
        <div className="mb-8 border-b border-primary/20 pb-4">
          <h1 className="text-3xl font-heading font-bold uppercase" data-testid="page-title">Code Generator</h1>
          <p className="text-muted-foreground text-sm">Generate Vendor-Specific PLC Code from Blueprints</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-heading uppercase mb-6 flex items-center gap-2">
              <Code className="w-5 h-5 text-primary" />
              Configuration
            </h2>

            <Tabs value={generationMode} onValueChange={(v) => setGenerationMode(v as GenerationMode)}>
              <TabsList className="w-full mb-4">
                <TabsTrigger value="vendor" className="flex-1" data-testid="tab-vendor">
                  <Settings className="w-4 h-4 mr-2" />
                  Vendor Code
                </TabsTrigger>
                <TabsTrigger value="ladder_logic" className="flex-1" data-testid="tab-ladder-logic">
                  <Cpu className="w-4 h-4 mr-2" />
                  Ladder Logic
                </TabsTrigger>
              </TabsList>

              <div className="space-y-4">
                <div>
                  <Label>Source Type</Label>
                  <Select value={sourceType} onValueChange={(v) => { setSourceType(v as SourceType); setSelectedSource(""); }}>
                    <SelectTrigger data-testid="select-source-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="control_module">Control Module</SelectItem>
                      <SelectItem value="phase">Phase</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Blueprint</Label>
                  <Select value={selectedSource} onValueChange={setSelectedSource}>
                    <SelectTrigger data-testid="select-blueprint">
                      <SelectValue placeholder="Select blueprint" />
                    </SelectTrigger>
                    <SelectContent>
                      {sources.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <TabsContent value="vendor" className="mt-0 space-y-4">
                  <div>
                    <Label>Target Vendor</Label>
                    <Select value={selectedVendor} onValueChange={setSelectedVendor}>
                      <SelectTrigger data-testid="select-target-vendor">
                        <SelectValue placeholder="Select vendor" />
                      </SelectTrigger>
                      <SelectContent>
                        {vendors.filter(v => v.isActive).map((v) => (
                          <SelectItem key={v.id} value={v.id}>{v.displayName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>Instance Name (optional)</Label>
                    <Input
                      data-testid="input-instance-name"
                      value={instanceName}
                      onChange={(e) => setInstanceName(e.target.value)}
                      placeholder="e.g., TIC4750_01"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="ladder_logic" className="mt-0 space-y-4">
                  <div className="border border-white/10 bg-white/5 p-4 space-y-3">
                    <h3 className="text-sm font-bold uppercase text-primary">Generation Options</h3>
                    
                    <div className="flex items-center justify-between">
                      <Label htmlFor="includeComments" className="text-sm">Include Comments</Label>
                      <Switch
                        id="includeComments"
                        checked={ladderOptions.includeComments}
                        onCheckedChange={(checked) => setLadderOptions(prev => ({ ...prev, includeComments: checked }))}
                        data-testid="switch-include-comments"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <Label htmlFor="generateFaultHandling" className="text-sm">Generate Fault Handling</Label>
                      <Switch
                        id="generateFaultHandling"
                        checked={ladderOptions.generateFaultHandling}
                        onCheckedChange={(checked) => setLadderOptions(prev => ({ ...prev, generateFaultHandling: checked }))}
                        data-testid="switch-fault-handling"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <Label htmlFor="generateInterlocks" className="text-sm">Generate Interlocks</Label>
                      <Switch
                        id="generateInterlocks"
                        checked={ladderOptions.generateInterlocks}
                        onCheckedChange={(checked) => setLadderOptions(prev => ({ ...prev, generateInterlocks: checked }))}
                        data-testid="switch-interlocks"
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Generates Studio 5000 neutral text format ladder logic for Rockwell PLCs.
                  </p>
                </TabsContent>

                <Button
                  onClick={handleGenerate}
                  disabled={!canGenerate || isPending}
                  className="w-full bg-primary text-black hover:bg-primary/80"
                  data-testid="button-generate"
                >
                  <Play className="w-4 h-4 mr-2" />
                  {isPending ? "Generating..." : generationMode === "ladder_logic" ? "Generate Ladder Logic" : "Generate Code"}
                </Button>
              </div>
            </Tabs>

            {errors.length > 0 && (
              <div className="mt-4 border border-red-500/30 bg-red-500/10 p-4">
                <div className="flex items-center gap-2 text-red-500 mb-2">
                  <AlertCircle className="w-4 h-4" />
                  <span className="font-bold">Errors</span>
                </div>
                <ul className="text-sm text-red-400 space-y-1">
                  {errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </div>

          <div className="border border-white/10 bg-white/5 p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-heading uppercase flex items-center gap-2">
                <Code className="w-5 h-5 text-primary" />
                Generated Code
              </h2>
              {generatedCode && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleCopy} data-testid="button-copy">
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                  <Button variant="outline" size="sm" data-testid="button-anchor">
                    <Anchor className="w-4 h-4 mr-1" /> Anchor
                  </Button>
                </div>
              )}
            </div>

            {codeHash && (
              <div className="mb-4 text-xs text-muted-foreground">
                Hash: <span className="text-primary font-mono">{codeHash.slice(0, 16)}...</span>
              </div>
            )}

            {ladderMetadata && (
              <div className="mb-4 flex gap-4 text-xs text-muted-foreground">
                <span>Rungs: <span className="text-primary">{ladderMetadata.rungCount}</span></span>
                <span>Instructions: <span className="text-primary">{ladderMetadata.instructionCount}</span></span>
                {ladderMetadata.tags && (
                  <span>Tags: <span className="text-primary">{ladderMetadata.tags.length}</span></span>
                )}
              </div>
            )}

            {visualDiagram && (
              <div className="flex gap-2 mb-2">
                <Button 
                  variant={codeViewMode === "visual" ? "default" : "outline"} 
                  size="sm"
                  onClick={() => setCodeViewMode("visual")}
                  data-testid="button-view-visual"
                >
                  Ladder Diagram
                </Button>
                <Button 
                  variant={codeViewMode === "neutral" ? "default" : "outline"} 
                  size="sm"
                  onClick={() => setCodeViewMode("neutral")}
                  data-testid="button-view-neutral"
                >
                  Neutral Text
                </Button>
              </div>
            )}

            <div className="bg-black/50 border border-white/10 p-4 h-[500px] overflow-auto">
              {generatedCode ? (
                <pre className="text-xs text-green-400 whitespace-pre" data-testid="generated-code">
                  {visualDiagram && codeViewMode === "visual" ? visualDiagram : generatedCode}
                </pre>
              ) : (
                <div className="text-muted-foreground text-center py-12">
                  {generationMode === "ladder_logic" 
                    ? "Select a blueprint and click Generate to create ladder logic."
                    : "Select a blueprint and vendor, then click Generate to create code."}
                </div>
              )}
            </div>

            {ladderMetadata?.tags && ladderMetadata.tags.length > 0 && (
              <div className="mt-4 border border-white/10 bg-white/5 p-4">
                <h3 className="text-sm font-bold uppercase text-primary mb-2">Required Tags</h3>
                <div className="space-y-1">
                  {ladderMetadata.tags.map((tag, i) => (
                    <div key={i} className="text-xs flex justify-between">
                      <span className="text-green-400 font-mono">{tag.name}</span>
                      <span className="text-muted-foreground">{tag.dataType}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
