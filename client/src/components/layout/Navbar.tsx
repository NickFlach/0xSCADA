import { Link } from "wouter";
import { Terminal, Factory, Bot, Box } from "lucide-react";

export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background border-b border-primary/30 h-16 flex items-center justify-between px-6 backdrop-blur-sm">
      <Link href="/">
        <div className="flex items-center gap-2 cursor-pointer group">
          <Terminal className="text-primary w-6 h-6" />
          <span className="text-xl font-heading font-bold tracking-tighter text-foreground group-hover:text-primary transition-colors">
            0x_SCADA
          </span>
        </div>
      </Link>

      <div className="hidden md:flex items-center gap-6 font-mono text-sm text-muted-foreground">
        <Link href="/dashboard" className="hover:text-primary transition-colors uppercase">[Dashboard]</Link>
        <Link href="/sites" className="hover:text-primary transition-colors uppercase">[Sites]</Link>
        <Link href="/events" className="hover:text-primary transition-colors uppercase">[Events]</Link>
        <Link href="/digital-twin" className="hover:text-primary transition-colors uppercase flex items-center gap-1" data-testid="nav-digital-twin">
          <Box className="w-3 h-3" />
          [Twin]
        </Link>
        <Link href="/blueprints" className="hover:text-primary transition-colors uppercase flex items-center gap-1">
          <Factory className="w-3 h-3" />
          [Blueprints]
        </Link>
        <Link href="/vendors" className="hover:text-primary transition-colors uppercase">[Vendors]</Link>
        <Link href="/codegen" className="hover:text-primary transition-colors uppercase">[CodeGen]</Link>
        <Link href="/agents" className="hover:text-primary transition-colors uppercase flex items-center gap-1">
          <Bot className="w-3 h-3" />
          [Agents]
        </Link>
      </div>

      <button className="bg-primary hover:bg-primary/80 text-black font-mono font-bold text-xs uppercase px-4 py-2 border border-primary transition-all hover:translate-x-[2px] hover:translate-y-[2px] active:translate-x-[0px] active:translate-y-[0px] shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)]" data-testid="button-connect-wallet">
        Connect_Wallet
      </button>
    </nav>
  );
}
