import { Navbar } from "@/components/layout/Navbar";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAASList, fetchAASById, fetchSubmodelWithElements, syncAAS } from "@/lib/api";
import { 
  Search, 
  RefreshCw, 
  Box, 
  Layers, 
  Database, 
  Link2, 
  ChevronRight,
  ChevronDown,
  Activity,
  Settings,
  FileText,
  Cpu,
  Anchor as AnchorIcon,
  ExternalLink,
} from "lucide-react";
import type { AssetAdministrationShell, AASSubmodel, AASSubmodelElement } from "@shared/schema";

function SubmodelIcon({ type }: { type: string }) {
  switch (type) {
    case "Nameplate":
      return <FileText className="w-4 h-4" />;
    case "TechnicalData":
      return <Settings className="w-4 h-4" />;
    case "OperationalData":
      return <Activity className="w-4 h-4" />;
    case "SimulationModel":
      return <Cpu className="w-4 h-4" />;
    case "BlockchainAnchor":
      return <AnchorIcon className="w-4 h-4" />;
    default:
      return <Layers className="w-4 h-4" />;
  }
}

function SubmodelCard({ 
  submodel, 
  aasId, 
  isExpanded, 
  onToggle 
}: { 
  submodel: AASSubmodel; 
  aasId: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { data: submodelWithElements } = useQuery({
    queryKey: ["submodel", aasId, submodel.id],
    queryFn: () => fetchSubmodelWithElements(aasId, submodel.id),
    enabled: isExpanded,
  });

  return (
    <div className="border border-white/10 bg-white/[0.02]" data-testid={`submodel-card-${submodel.id}`}>
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-center justify-between hover:bg-white/5 transition-colors"
        data-testid={`submodel-toggle-${submodel.id}`}
      >
        <div className="flex items-center gap-3">
          <SubmodelIcon type={submodel.submodelType} />
          <div className="text-left">
            <div className="font-bold text-sm">{submodel.idShort}</div>
            <div className="text-xs text-muted-foreground">{submodel.submodelType}</div>
          </div>
        </div>
        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      
      {isExpanded && submodelWithElements?.elements && (
        <div className="border-t border-white/10 p-3 space-y-2 bg-white/[0.01]">
          {submodelWithElements.elements.length === 0 && (
            <div className="text-xs text-muted-foreground italic">No elements</div>
          )}
          {submodelWithElements.elements.map((element) => (
            <div 
              key={element.id} 
              className="flex items-start justify-between text-xs border-b border-white/5 pb-2 last:border-0"
              data-testid={`element-${element.id}`}
            >
              <div>
                <span className="font-mono font-bold">{element.idShort}</span>
                <span className="text-muted-foreground ml-2">({element.elementType})</span>
                {element.displayName && (
                  <div className="text-muted-foreground">{element.displayName}</div>
                )}
              </div>
              <div className="text-right">
                {element.value && (
                  <div className="font-mono text-primary max-w-48 truncate" title={element.value}>
                    {element.value.length > 30 ? element.value.slice(0, 30) + "..." : element.value}
                  </div>
                )}
                {element.valueType && (
                  <div className="text-muted-foreground">{element.valueType}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AASDetailPanel({ aas }: { aas: AssetAdministrationShell }) {
  const [expandedSubmodels, setExpandedSubmodels] = useState<Set<string>>(new Set());
  
  const { data: aasWithSubmodels } = useQuery({
    queryKey: ["aas", aas.id],
    queryFn: () => fetchAASById(aas.id),
  });

  const toggleSubmodel = (smId: string) => {
    setExpandedSubmodels((prev) => {
      const next = new Set(prev);
      if (next.has(smId)) {
        next.delete(smId);
      } else {
        next.add(smId);
      }
      return next;
    });
  };

  return (
    <div className="border border-white/10 bg-white/5" data-testid={`aas-detail-${aas.id}`}>
      <div className="p-4 border-b border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-3 mb-2">
          <Box className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold">{aas.displayName || aas.idShort}</h2>
        </div>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-muted-foreground">Global ID:</span>
            <div className="font-mono truncate" title={aas.globalId}>{aas.globalId}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Asset ID:</span>
            <div className="font-mono truncate" title={aas.globalAssetId}>{aas.globalAssetId}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Type:</span>
            <div className="font-bold">{aas.assetType || "Unknown"}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Kind:</span>
            <div className="font-bold">{aas.assetKind}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Version:</span>
            <div>{aas.version}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Anchor Status:</span>
            <div className={aas.anchorTxHash ? "text-primary" : "text-yellow-500"}>
              {aas.anchorTxHash ? "Anchored" : "Pending"}
            </div>
          </div>
        </div>
        {aas.description && (
          <p className="text-xs text-muted-foreground mt-3">{aas.description}</p>
        )}
      </div>
      
      <div className="p-4">
        <h3 className="text-sm font-bold uppercase mb-3 flex items-center gap-2">
          <Layers className="w-4 h-4" />
          Submodels ({aasWithSubmodels?.submodels?.length || 0})
        </h3>
        <div className="space-y-2">
          {aasWithSubmodels?.submodels?.map((sm) => (
            <SubmodelCard 
              key={sm.id} 
              submodel={sm} 
              aasId={aas.id}
              isExpanded={expandedSubmodels.has(sm.id)}
              onToggle={() => toggleSubmodel(sm.id)}
            />
          ))}
          {!aasWithSubmodels?.submodels?.length && (
            <div className="text-xs text-muted-foreground italic p-4 border border-dashed border-white/10 text-center">
              No submodels found. Run sync to populate.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DigitalTwin() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedAAS, setSelectedAAS] = useState<AssetAdministrationShell | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const queryClient = useQueryClient();

  const { data: aasList = [], isLoading } = useQuery({
    queryKey: ["aas-list"],
    queryFn: fetchAASList,
    refetchInterval: 10000,
  });

  const syncMutation = useMutation({
    mutationFn: syncAAS,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["aas-list"] });
      console.log("Sync completed:", result);
    },
  });

  const assetTypes = [...new Set(aasList.map((a) => a.assetType || "Unknown"))];

  const filteredList = aasList.filter((aas) => {
    const matchesSearch = 
      aas.idShort.toLowerCase().includes(searchTerm.toLowerCase()) ||
      aas.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      aas.globalId.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === "all" || aas.assetType === filterType;
    return matchesSearch && matchesType;
  });

  const stats = {
    total: aasList.length,
    sites: aasList.filter((a) => a.assetType === "Site").length,
    assets: aasList.filter((a) => a.assetType !== "Site").length,
    anchored: aasList.filter((a) => a.anchorTxHash).length,
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-12">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
          <div>
            <h1 className="text-3xl font-heading font-bold uppercase" data-testid="page-title">
              Digital Twin Registry
            </h1>
            <p className="text-muted-foreground text-sm">
              Asset Administration Shell (IEC 63278) // Industry 4.0 Digital Twins
            </p>
          </div>
          <div className="flex gap-2 w-full md:w-auto">
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              data-testid="sync-button"
            >
              <RefreshCw className={`w-4 h-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              {syncMutation.isPending ? "Syncing..." : "Sync All"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="border border-white/10 p-4 bg-white/5" data-testid="stat-total">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-xs text-muted-foreground uppercase">Total Twins</div>
          </div>
          <div className="border border-white/10 p-4 bg-white/5" data-testid="stat-sites">
            <div className="text-2xl font-bold">{stats.sites}</div>
            <div className="text-xs text-muted-foreground uppercase">Sites</div>
          </div>
          <div className="border border-white/10 p-4 bg-white/5" data-testid="stat-assets">
            <div className="text-2xl font-bold">{stats.assets}</div>
            <div className="text-xs text-muted-foreground uppercase">Assets</div>
          </div>
          <div className="border border-white/10 p-4 bg-white/5" data-testid="stat-anchored">
            <div className="text-2xl font-bold text-primary">{stats.anchored}</div>
            <div className="text-xs text-muted-foreground uppercase">Anchored</div>
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by ID, name, or global ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white/5 border border-white/20 pl-10 pr-4 py-2 text-sm focus:border-primary outline-none transition-colors"
              data-testid="search-input"
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="bg-white/5 border border-white/20 px-4 py-2 text-sm focus:border-primary outline-none"
            data-testid="filter-type"
          >
            <option value="all">All Types</option>
            {assetTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-2 max-h-[70vh] overflow-y-auto">
            {isLoading && (
              <div className="text-center text-muted-foreground py-8">Loading...</div>
            )}
            {!isLoading && filteredList.length === 0 && (
              <div className="text-center text-muted-foreground py-8 border border-dashed border-white/10">
                {aasList.length === 0 
                  ? "No digital twins found. Click 'Sync All' to create from existing assets."
                  : "No matches found for your search criteria."
                }
              </div>
            )}
            {filteredList.map((aas) => (
              <button
                key={aas.id}
                onClick={() => setSelectedAAS(aas)}
                className={`w-full text-left p-3 border transition-colors ${
                  selectedAAS?.id === aas.id 
                    ? "border-primary bg-primary/10" 
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
                data-testid={`aas-item-${aas.id}`}
              >
                <div className="flex items-center gap-3">
                  <Box className={`w-4 h-4 ${aas.assetType === "Site" ? "text-blue-400" : "text-primary"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm truncate">{aas.displayName || aas.idShort}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>{aas.assetType || "Unknown"}</span>
                      {aas.anchorTxHash && <Link2 className="w-3 h-3 text-primary" />}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </button>
            ))}
          </div>

          <div className="lg:col-span-2">
            {selectedAAS ? (
              <AASDetailPanel aas={selectedAAS} />
            ) : (
              <div className="border border-dashed border-white/20 bg-white/[0.02] p-12 text-center">
                <Database className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-bold mb-2">Select a Digital Twin</h3>
                <p className="text-sm text-muted-foreground">
                  Choose an Asset Administration Shell from the list to view its details and submodels.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
