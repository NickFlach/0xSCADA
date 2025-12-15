import { motion } from "framer-motion";

export function Ticker() {
  const words = [
    "DECENTRALIZED", "PERMISSIONLESS", "IMMUTABLE", "CENSORSHIP-RESISTANT", 
    "HIGH-AVAILABILITY", "LOW-LATENCY", "CRYPTOGRAPHIC-PROOF", "ZERO-KNOWLEDGE"
  ];

  return (
    <div className="bg-primary overflow-hidden py-3 border-y border-black">
      <motion.div 
        className="flex whitespace-nowrap"
        animate={{ x: "-50%" }}
        transition={{ 
          repeat: Infinity, 
          ease: "linear", 
          duration: 10 
        }}
      >
        {[...words, ...words, ...words].map((word, i) => (
          <div key={i} className="flex items-center mx-4">
            <span className="text-black font-heading font-black text-2xl uppercase tracking-tight">
              {word}
            </span>
            <span className="ml-8 text-black font-mono font-bold">///</span>
          </div>
        ))}
      </motion.div>
    </div>
  );
}
