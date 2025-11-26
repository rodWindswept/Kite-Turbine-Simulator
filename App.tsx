import React from 'react';
import KiteTurbineSimulation from './components/KiteTurbineSimulation';

const App: React.FC = () => {
  return (
    <div className="w-full h-screen relative bg-slate-900 overflow-hidden">
      <KiteTurbineSimulation />
      
      {/* Overlay Header */}
      <div className="absolute top-0 left-0 w-full p-6 pointer-events-none bg-gradient-to-b from-slate-900/80 to-transparent">
        <h1 className="text-3xl font-bold text-white drop-shadow-md">Kite Turbine Architecture</h1>
        <p className="text-white/80 max-w-lg mt-1 text-sm drop-shadow-sm">
           Tensile Rotary Power Transmission (TRPT) System
        </p>
      </div>
    </div>
  );
};

export default App;