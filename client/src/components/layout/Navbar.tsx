import { Link } from "wouter";
import { Terminal, Cpu, Zap } from "lucide-react";

export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background border-b border-primary/30 h-16 flex items-center justify-between px-6 backdrop-blur-sm">
      <Link href="/">
        <div className="flex items-center gap-2 cursor-pointer group">
          <Terminal className="text-primary w-6 h-6" />
          <span className="text-xl font-heading font-bold tracking-tighter text-foreground group-hover:text-primary transition-colors">
            0x_INFRA
          </span>
        </div>
      </Link>

      <div className="hidden md:flex items-center gap-8 font-mono text-sm text-muted-foreground">
        <a href="#features" className="hover:text-primary transition-colors uppercase">[Nodes]</a>
        <a href="#pricing" className="hover:text-primary transition-colors uppercase">[Pricing]</a>
        <a href="#docs" className="hover:text-primary transition-colors uppercase">[Docs]</a>
      </div>

      <button className="bg-primary hover:bg-primary/80 text-black font-mono font-bold text-xs uppercase px-4 py-2 border border-primary transition-all hover:translate-x-[2px] hover:translate-y-[2px] active:translate-x-[0px] active:translate-y-[0px] shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]">
        Connect_Wallet
      </button>
    </nav>
  );
}
