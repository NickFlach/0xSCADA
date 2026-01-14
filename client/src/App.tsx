import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import Sites from "@/pages/sites";
import Events from "@/pages/events";
import Blueprints from "@/pages/blueprints";
import Vendors from "@/pages/vendors";
import CodeGen from "@/pages/codegen";
import Agents from "@/pages/agents";
import DigitalTwin from "@/pages/digital-twin";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/sites" component={Sites} />
      <Route path="/events" component={Events} />
      <Route path="/blueprints" component={Blueprints} />
      <Route path="/vendors" component={Vendors} />
      <Route path="/codegen" component={CodeGen} />
      <Route path="/agents" component={Agents} />
      <Route path="/digital-twin" component={DigitalTwin} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
