import { Navbar } from "@/components/layout/Navbar";
import { Hero } from "@/components/landing/Hero";
import { Ticker } from "@/components/landing/Ticker";
import { Features } from "@/components/landing/Features";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-black">
      <Navbar />
      <Hero />
      <Ticker />
      <Features />
      
      {/* Brutalist Footer */}
      <footer className="bg-black border-t border-white/20 py-12">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-start gap-8">
          <div>
            <h2 className="text-4xl font-heading font-bold text-white mb-2">0x_INFRA</h2>
            <p className="font-mono text-muted-foreground text-sm max-w-xs">
              Building the decentralized future, one block at a time.
            </p>
          </div>
          
          <div className="grid grid-cols-2 gap-12 font-mono text-sm">
            <div className="flex flex-col gap-2">
              <span className="text-primary mb-2 uppercase tracking-widest text-xs">Platform</span>
              <a href="#" className="hover:text-white transition-colors">Nodes</a>
              <a href="#" className="hover:text-white transition-colors">API</a>
              <a href="#" className="hover:text-white transition-colors">Status</a>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-primary mb-2 uppercase tracking-widest text-xs">Company</span>
              <a href="#" className="hover:text-white transition-colors">About</a>
              <a href="#" className="hover:text-white transition-colors">Careers</a>
              <a href="#" className="hover:text-white transition-colors">Blog</a>
            </div>
          </div>
        </div>
        <div className="container mx-auto px-6 mt-12 pt-8 border-t border-white/10 flex justify-between items-center font-mono text-xs text-muted-foreground">
          <p>© 2025 0x_INFRA INC.</p>
          <p>SYSTEM_NORMAL</p>
        </div>
      </footer>
    </div>
  );
}
