import { Navbar } from "@/components/layout/Navbar";
import { Code, Play, Anchor, Copy, Check, AlertCircle } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchControlModuleTypes, fetchPhaseTypes, fetchVendors, generateControlModuleCode, generatePhaseCode } from "@/lib/api";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

type SourceType = "control_module" | "phase";

export default function CodeGen() {
  const [sourceType, setSourceType] = useState<SourceType>("control_module");
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [selectedVendor, setSelectedVendor] = useState<string>("");
  const [instanceName, setInstanceName] = useState("");
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [codeHash, setCodeHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

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

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (sourceType === "control_module") {
        return generateControlModuleCode(selectedSource, selectedVendor, { instanceName: instanceName || undefined });
      } else {
        return generatePhaseCode(selectedSource, selectedVendor, { instanceName: instanceName || undefined });
      }
    },
    onSuccess: (result) => {
      if (result.success) {
        setGeneratedCode(result.code);
        setCodeHash(result.codeHash);
        setErrors([]);
      } else {
        setErrors(result.errors || ["Unknown error"]);
        setGeneratedCode(null);
      }
    },
    onError: (error: Error) => {
      setErrors([error.message]);
      setGeneratedCode(null);
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

  const canGenerate = selectedSource && selectedVendor;

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

              <Button
                onClick={() => generateMutation.mutate()}
                disabled={!canGenerate || generateMutation.isPending}
                className="w-full bg-primary text-black hover:bg-primary/80"
                data-testid="button-generate"
              >
                <Play className="w-4 h-4 mr-2" />
                {generateMutation.isPending ? "Generating..." : "Generate Code"}
              </Button>
            </div>

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

            <div className="bg-black/50 border border-white/10 p-4 h-[500px] overflow-auto">
              {generatedCode ? (
                <pre className="text-xs text-green-400 whitespace-pre-wrap" data-testid="generated-code">
                  {generatedCode}
                </pre>
              ) : (
                <div className="text-muted-foreground text-center py-12">
                  Select a blueprint and vendor, then click Generate to create code.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
