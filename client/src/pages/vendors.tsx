import { Navbar } from "@/components/layout/Navbar";
import { Building2, FileCode, Settings, Code } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fetchVendors, fetchTemplates } from "@/lib/api";
import { useState } from "react";

export default function Vendors() {
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);

  const { data: vendors = [] } = useQuery({
    queryKey: ["vendors"],
    queryFn: fetchVendors,
  });

  const { data: templates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
  });

  const selectedVendorData = vendors.find(v => v.id === selectedVendor);
  const vendorTemplates = templates.filter(t => t.vendorId === selectedVendor);

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-12">
        <div className="mb-8 border-b border-primary/20 pb-4">
          <h1 className="text-3xl font-heading font-bold uppercase" data-testid="page-title">Vendor Management</h1>
          <p className="text-muted-foreground text-sm">Industrial Automation Vendors // Code Templates // Data Type Mappings</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-heading uppercase mb-6 flex items-center gap-2">
              <Building2 className="w-5 h-5 text-primary" />
              Vendors
            </h2>
            <div className="space-y-2">
              {vendors.map((vendor) => (
                <button
                  key={vendor.id}
                  onClick={() => setSelectedVendor(vendor.id)}
                  className={`w-full text-left p-3 border transition-colors ${
                    selectedVendor === vendor.id
                      ? "border-primary bg-primary/10"
                      : "border-white/10 hover:border-primary/50 hover:bg-white/5"
                  }`}
                  data-testid={`vendor-${vendor.id}`}
                >
                  <div className="font-bold">{vendor.displayName}</div>
                  <div className="text-xs text-muted-foreground">{vendor.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            {selectedVendorData ? (
              <>
                <div className="border border-white/10 bg-white/5 p-6">
                  <h2 className="text-xl font-heading uppercase mb-4 flex items-center gap-2">
                    <Settings className="w-5 h-5 text-primary" />
                    {selectedVendorData.displayName}
                  </h2>
                  <p className="text-muted-foreground mb-4">{selectedVendorData.description}</p>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="text-sm font-bold text-primary mb-2">Platforms</h3>
                      <div className="flex flex-wrap gap-1">
                        {(selectedVendorData.platforms as string[])?.map((p, i) => (
                          <span key={i} className="text-xs bg-white/10 px-2 py-1">{p}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-primary mb-2">Languages</h3>
                      <div className="flex flex-wrap gap-1">
                        {(selectedVendorData.languages as string[])?.map((l, i) => (
                          <span key={i} className="text-xs bg-primary/20 text-primary px-2 py-1">{l}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="border border-white/10 bg-white/5 p-6">
                  <h2 className="text-xl font-heading uppercase mb-4 flex items-center gap-2">
                    <Code className="w-5 h-5 text-primary" />
                    Templates ({vendorTemplates.length})
                  </h2>
                  {vendorTemplates.length === 0 ? (
                    <p className="text-muted-foreground">No templates for this vendor.</p>
                  ) : (
                    <div className="space-y-3">
                      {vendorTemplates.map((template) => (
                        <div key={template.id} className="border border-white/10 p-3 hover:bg-white/5 transition-colors" data-testid={`template-${template.id}`}>
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="font-bold">{template.name}</div>
                              <div className="text-xs text-muted-foreground">{template.description}</div>
                            </div>
                            <div className="flex gap-2">
                              <span className="text-xs bg-primary/20 text-primary px-2 py-0.5">{template.language}</span>
                              <span className="text-xs bg-white/10 px-2 py-0.5">{template.templateType}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="border border-white/10 bg-white/5 p-6 text-center text-muted-foreground">
                Select a vendor to view details and templates.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
