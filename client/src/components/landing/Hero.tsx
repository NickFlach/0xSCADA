import { motion } from "framer-motion";
import wireframeImg from "@assets/generated_images/abstract_wireframe_geometric_shape.png";
import textureImg from "@assets/generated_images/gritty_concrete_texture_with_digital_noise_overlay.png";

export function Hero() {
  return (
    <div className="relative min-h-[90vh] flex flex-col justify-center items-center border-b border-white/10 overflow-hidden pt-20">
      {/* Texture Overlay */}
      <div 
        className="absolute inset-0 opacity-10 pointer-events-none mix-blend-overlay"
        style={{ backgroundImage: `url(${textureImg})`, backgroundSize: 'cover' }}
      />

      <div className="container mx-auto px-6 relative z-10 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        <div className="flex flex-col gap-6">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 border border-primary/50 bg-primary/5 px-3 py-1 w-fit"
          >
            <div className="w-2 h-2 bg-primary animate-pulse" />
            <span className="text-primary font-mono text-xs uppercase tracking-widest">System Operational</span>
          </motion.div>

          <motion.h1 
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="text-6xl md:text-8xl font-heading font-bold leading-[0.85] tracking-tighter uppercase"
          >
            Unstoppable<br/>
            <span className="text-stroke text-transparent hover:text-primary transition-colors duration-300">Infra</span><br/>
            Structure
          </motion.h1>

          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.4 }}
            className="font-mono text-muted-foreground text-lg md:text-xl max-w-md border-l-2 border-primary pl-4"
          >
            DePIN architecture for the sovereign web. Censorship resistant. High throughput. Zero latency.
          </motion.p>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.6 }}
            className="flex flex-wrap gap-4 mt-4"
          >
            <button className="bg-foreground text-background font-mono font-bold uppercase px-8 py-4 border-2 border-foreground hover:bg-transparent hover:text-foreground transition-all">
              Deploy_Node()
            </button>
            <button className="bg-transparent text-primary font-mono font-bold uppercase px-8 py-4 border-2 border-primary hover:bg-primary hover:text-black transition-all">
              Read_Docs
            </button>
          </motion.div>
        </div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1 }}
          className="relative hidden md:flex justify-center items-center"
        >
           <div className="relative w-[500px] h-[500px]">
             {/* Spinning geometric shape */}
             <motion.img 
               src={wireframeImg} 
               alt="Abstract Geometry"
               className="w-full h-full object-contain mix-blend-screen grayscale contrast-150"
               animate={{ rotate: 360 }}
               transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
             />
             <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent" />
           </div>
           
           {/* Decorative Code Block */}
           <div className="absolute bottom-10 -right-10 bg-black/80 border border-white/20 p-4 font-mono text-xs text-primary backdrop-blur-md">
             <p>{`> init_sequence_start`}</p>
             <p>{`> connecting to mesh...`}</p>
             <p>{`> 100% packet_loss: 0`}</p>
             <p className="animate-pulse">{`> ready_`}</p>
           </div>
        </motion.div>
      </div>
      
      {/* Scroll Indicator */}
      <motion.div 
        className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
        animate={{ y: [0, 10, 0] }}
        transition={{ repeat: Infinity, duration: 2 }}
      >
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Scroll</span>
        <div className="w-[1px] h-12 bg-primary/50" />
      </motion.div>
    </div>
  );
}
