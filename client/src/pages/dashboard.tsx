import { Navbar } from "@/components/layout/Navbar";
import { Activity, ShieldCheck, AlertTriangle, Database, Layers } from "lucide-react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { fetchSites, fetchAssets, fetchEvents, fetchBatchStats } from "@/lib/api";

export default function Dashboard() {
  const { data: sites = [] } = useQuery({
    queryKey: ["sites"],
    queryFn: fetchSites,
    refetchInterval: 5000,
  });

  const { data: assets = [] } = useQuery({
    queryKey: ["assets"],
    queryFn: fetchAssets,
    refetchInterval: 5000,
  });

  const { data: events = [] } = useQuery({
    queryKey: ["events"],
    queryFn: () => fetchEvents(10),
    refetchInterval: 2000,
  });

  const { data: batchStats } = useQuery({
    queryKey: ["batchStats"],
    queryFn: fetchBatchStats,
    refetchInterval: 5000,
  });

  const onlineSites = sites.filter(s => s.status === "ONLINE").length;
  const criticalAssets = assets.filter(a => a.critical).length;

  return (
    <div className="min-h-screen bg-background text-foreground font-mono">
      <Navbar />
      <div className="container mx-auto px-6 pt-24 pb-12">
        <div className="mb-8 flex justify-between items-end border-b border-primary/20 pb-4">
          <div>
            <h1 className="text-3xl font-heading font-bold uppercase">Operations Console</h1>
            <p className="text-muted-foreground text-sm">System Overview // Network Status: CONNECTED</p>
          </div>
          <div className="text-right hidden md:block">
            <p className="text-xs text-primary animate-pulse">LIVE DATA STREAM</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
          <StatCard 
            label="Active Sites" 
            value={onlineSites.toString()} 
            total={sites.length.toString()} 
            icon={Database} 
            status="good"
          />
          <StatCard 
            label="Critical Assets" 
            value={criticalAssets.toString()} 
            subtext="Monitored" 
            icon={ShieldCheck} 
            status="neutral"
          />
          <StatCard 
            label="Recent Events" 
            value={events.length.toString()} 
            subtext="Last 10 events" 
            icon={Activity} 
            status="good"
          />
          <StatCard 
            label="Active Alerts" 
            value={assets.filter(a => a.status === "WARNING").length.toString()} 
            subtext="Requires Attention" 
            icon={AlertTriangle} 
            status={assets.filter(a => a.status === "WARNING").length > 0 ? "warning" : "good"}
          />
        </div>

        <div className="mb-8 border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Layers className="w-5 h-5 text-primary" />
              <div>
                <h3 className="text-sm font-bold uppercase">Batch Anchoring</h3>
                <p className="text-xs text-muted-foreground">Merkle tree batching for gas-efficient L1 anchoring</p>
              </div>
            </div>
            <div className="flex gap-6 text-xs">
              <div className="text-center">
                <div className="text-lg font-bold text-primary">{batchStats?.stats.pendingEvents || 0}</div>
                <div className="text-muted-foreground uppercase">Pending</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold">{batchStats?.stats.totalBatchesAnchored || 0}</div>
                <div className="text-muted-foreground uppercase">Batches</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold">{batchStats?.stats.totalEventsAnchored || 0}</div>
                <div className="text-muted-foreground uppercase">Anchored</div>
              </div>
              <div className="text-center">
                <div className={`text-lg font-bold ${batchStats?.config.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                  {batchStats?.config.enabled ? 'ON' : 'OFF'}
                </div>
                <div className="text-muted-foreground uppercase">Status</div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-heading uppercase mb-6 flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              Event Stream
            </h2>
            <div className="space-y-4">
              {events.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  Waiting for events from field simulator...
                </div>
              ) : (
                events.map(evt => {
                  const asset = assets.find(a => a.id === evt.assetId);
                  return (
                    <div key={evt.id} className="flex flex-col md:flex-row gap-4 border-b border-white/5 pb-4 last:border-0 hover:bg-white/5 p-2 transition-colors cursor-pointer group">
                      <div className="min-w-[140px]">
                        <span className="text-xs text-muted-foreground block">
                          {new Date(evt.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="text-xs font-bold text-primary">{evt.eventType}</span>
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-bold mb-1 group-hover:text-primary transition-colors">
                          {asset?.nameOrTag || evt.assetId}
                        </div>
                        <div className="text-xs text-muted-foreground">{evt.details}</div>
                      </div>
                      <div className="text-right">
                        {evt.txHash ? (
                          <span className="text-[10px] bg-primary/20 text-primary px-2 py-1 uppercase border border-primary/30">
                            Tx: {evt.txHash.slice(0, 6)}...
                          </span>
                        ) : (
                          <span className="text-[10px] bg-yellow-500/20 text-yellow-500 px-2 py-1 uppercase border border-yellow-500/30">
                            Pending
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="mt-6 text-right">
              <Link href="/events">
                <span className="text-sm text-primary hover:underline cursor-pointer uppercase font-bold">View Full Log &rarr;</span>
              </Link>
            </div>
          </div>

          <div className="border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-heading uppercase mb-6 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" />
              System Health
            </h2>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-xs mb-2 uppercase">
                  <span>Gateway Latency</span>
                  <span className="text-primary">12ms</span>
                </div>
                <div className="h-1 bg-white/10 w-full">
                  <div className="h-full bg-primary w-[15%]" />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-2 uppercase">
                  <span>Database</span>
                  <span className="text-primary">Connected</span>
                </div>
                <div className="h-1 bg-white/10 w-full">
                  <div className="h-full bg-primary w-[100%]" />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-2 uppercase">
                  <span>Simulator</span>
                  <span className="text-primary">Active</span>
                </div>
                <div className="h-1 bg-white/10 w-full">
                  <div className="h-full bg-primary w-[100%]" />
                </div>
              </div>
            </div>
            
            <div className="mt-12 p-4 border border-dashed border-white/20 bg-black/40">
              <h3 className="text-xs font-bold uppercase text-muted-foreground mb-2">Network Stats</h3>
              <div className="space-y-2 text-xs">
                 <div className="flex justify-between">
                   <span>Total Sites</span>
                   <span className="font-bold">{sites.length}</span>
                 </div>
                 <div className="flex justify-between">
                   <span>Total Assets</span>
                   <span className="font-bold">{assets.length}</span>
                 </div>
                 <div className="flex justify-between">
                   <span>Total Events</span>
                   <span className="font-bold">{events.length}+</span>
                 </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, total, subtext, icon: Icon, status }: any) {
  const statusColors = {
    good: "text-primary border-primary/30",
    warning: "text-destructive border-destructive/30",
    neutral: "text-white border-white/20"
  };

  const statusColor = statusColors[status as keyof typeof statusColors] || statusColors.neutral;

  return (
    <div className={`p-6 border bg-white/5 ${statusColor} relative overflow-hidden group hover:bg-white/10 transition-colors`}>
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</h3>
        <Icon className={`w-5 h-5 ${status === 'warning' ? 'text-destructive' : 'text-primary'} opacity-80`} />
      </div>
      <div className="text-4xl font-heading font-bold mb-1">
        {value} <span className="text-lg text-muted-foreground font-normal">{total ? `/ ${total}` : ''}</span>
      </div>
      {subtext && (
        <div className="text-xs text-muted-foreground border-t border-white/10 pt-2 mt-2">
          {subtext}
        </div>
      )}
      <div className={`absolute bottom-0 left-0 h-[2px] w-full ${status === 'warning' ? 'bg-destructive' : 'bg-primary'} scale-x-0 group-hover:scale-x-100 transition-transform origin-left duration-300`} />
    </div>
  );
}
