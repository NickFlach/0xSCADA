import { Server, Database, Globe, Lock, Cpu, Activity } from "lucide-react";
import { motion } from "framer-motion";

const features = [
  {
    icon: Server,
    title: "RPC Nodes",
    desc: "Direct access to 40+ chains. 99.99% uptime SLA. Websocket support."
  },
  {
    icon: Database,
    title: "Indexer API",
    desc: "Query blockchain data with SQL-like precision. Historical data access."
  },
  {
    icon: Globe,
    title: "Global Mesh",
    desc: "Distributed node network across 15 regions. Auto-failover routing."
  },
  {
    icon: Lock,
    title: "ZK Proofs",
    desc: "Generate proofs on demand. Dedicated prover instances available."
  },
  {
    icon: Cpu,
    title: "Dedicated Hardware",
    desc: "Bare metal performance. No shared resources. Full isolation."
  },
  {
    icon: Activity,
    title: "Real-time Analytics",
    desc: "Deep insights into dApp usage. Mempool monitoring and alerts."
  }
];

export function Features() {
  return (
    <div className="py-24 bg-background relative" id="features">
      <div className="container mx-auto px-6">
        <div className="mb-16 border-b border-white/20 pb-4 flex justify-between items-end">
          <h2 className="text-4xl md:text-6xl font-heading uppercase text-white">
            System<br/><span className="text-primary">Capabilities</span>
          </h2>
          <span className="font-mono text-muted-foreground hidden md:block">
            // INDEX: 002<br/>
            // STATUS: ACTIVE
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 border-t border-l border-white/10">
          {features.map((feature, i) => (
            <div 
              key={i} 
              className="group border-r border-b border-white/10 p-8 hover:bg-white/5 transition-colors relative overflow-hidden"
            >
              <div className="absolute top-4 right-4 font-mono text-xs text-muted-foreground opacity-50">
                0{i + 1}
              </div>
              
              <div className="mb-6 p-3 bg-white/5 w-fit border border-white/10 group-hover:border-primary/50 group-hover:bg-primary/10 transition-all">
                <feature.icon className="w-8 h-8 text-foreground group-hover:text-primary transition-colors" />
              </div>
              
              <h3 className="text-2xl font-heading uppercase mb-3 text-white group-hover:text-primary transition-colors">
                {feature.title}
              </h3>
              
              <p className="font-mono text-sm text-muted-foreground leading-relaxed">
                {feature.desc}
              </p>

              <div className="absolute bottom-0 left-0 w-0 h-[2px] bg-primary group-hover:w-full transition-all duration-300" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
