import React, { useEffect, useRef, useState } from 'react';

// --- Types & Constants ---

interface Point3D {
  x: number;
  y: number;
  z: number;
}

interface Point2D {
  x: number;
  y: number;
}

interface ScreenPoint {
    x: number;
    y: number;
    z: number; // Depth for sorting
}

interface LabelData {
    target: Point2D;
    anchor: Point2D;
    extraText?: string;
    subText?: string; 
    statusColor?: string;
}

// Configuration for the structure
const MAX_BASE_OFFSET_Y = 280; 
const ROTOR_RADIUS_SCALE = 1050; // Visual radius units
// Physics constants
const TSR_MAX_BASE = 6.0;

// Orientation Physics
const ELEVATION_ANGLE_DEG = 30;
const FLYING_TILT = (90 - ELEVATION_ANGLE_DEG) * Math.PI / 180;
const GROUND_TILT = Math.PI / 2; // 90 degrees (flat on ground)

const KiteTurbineSimulation: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Simulation State
  const [envWindSpeed, setEnvWindSpeed] = useState<number>(12); // Environmental Wind Speed (m/s)
  const [torque, setTorque] = useState<number>(50); // Generator Torque (0-100%)
  const [isAutoPilot, setIsAutoPilot] = useState<boolean>(false);
  
  // Read-only Physics State (Throttled for UI)
  const [uiRpm, setUiRpm] = useState<number>(0);
  const [uiTsr, setUiTsr] = useState<number>(0);
  const [uiStatus, setUiStatus] = useState<string>("Initializing");
  const [uiRunaway, setUiRunaway] = useState<boolean>(false);
  const [uiGrounded, setUiGrounded] = useState<boolean>(false);

  // Physics Refs (High frequency updates)
  const physicsState = useRef({
      rpm: 0, 
      tsr: 0,
      kw: 0,
      compressionRisk: false,
      overspeedRisk: false,
      isRunaway: false,
      optimalTsr: 4.0 // Dynamic
  });
  
  // Animation State
  const deploymentRef = useRef<number>(1.0); // 0.0 (Grounded) to 1.0 (Flying)

  // Interactive Parameters
  const [bladeCount, setBladeCount] = useState<number>(6);
  const [bladeLengthOut, setBladeLengthOut] = useState<number>(380);
  const [bladeLengthIn, setBladeLengthIn] = useState<number>(230);

  // Camera State 
  const cameraState = useRef({
    theta: Math.PI + (15 * Math.PI / 180),    
    phi: 0.1 - (10 * Math.PI / 180),          
    radius: 17000 * 0.85,     
    targetY: 2500,     
    targetX: -850,        
    targetZ: 1500,     
  });

  const mouseState = useRef({
    isDragging: false,
    isPanning: false,
    lastX: 0,
    lastY: 0,
  });

  const frameId = useRef<number>(0);
  const rotationRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(Date.now());

  const [labels, setLabels] = useState<{ [key: string]: LabelData | null }>({
    liftKite: null,
    rotor: null,
    trpt: null,
    generator: null,
  });

  // --- Physics Loop ---
  useEffect(() => {
      // Create a separate interval for UI updates to avoid React render thrashing
      const uiInterval = setInterval(() => {
          setUiRpm(parseFloat(physicsState.current.rpm.toFixed(1)));
          setUiTsr(parseFloat(physicsState.current.tsr.toFixed(2)));
          setUiRunaway(physicsState.current.isRunaway);
          setUiGrounded(deploymentRef.current < 0.1);
          
          let status = "OPTIMAL";
          const optimal = physicsState.current.optimalTsr;
          
          if (deploymentRef.current < 0.5) status = "GROUNDED";
          else if (physicsState.current.isRunaway) status = "RUNAWAY";
          else if (envWindSpeed <= 3) status = "GROUNDED";
          else if (physicsState.current.tsr < optimal * 0.6) status = "STALL";
          else if (physicsState.current.tsr > optimal * 1.25) status = "OVERSPEED";
          
          setUiStatus(status);
      }, 100);
      return () => clearInterval(uiInterval);
  }, [envWindSpeed, isAutoPilot]); // Dependencies

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    const fov = 2000; 

    // Dynamic 3D Helpers inside render to support animation state
    const render = () => {
      if (!canvas || !ctx) return;
      const width = canvas.width;
      const height = canvas.height;
      const now = Date.now();
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      // --- Deployment State Logic ---
      const isGroundedCondition = envWindSpeed <= 3;
      const targetDeployment = isGroundedCondition ? 0.0 : 1.0;
      const deployDiff = targetDeployment - deploymentRef.current;
      
      if (Math.abs(deployDiff) > 0.001) {
          deploymentRef.current += deployDiff * dt * 0.8; // Transition speed
      } else {
          deploymentRef.current = targetDeployment;
      }
      
      const depl = Math.max(0, Math.min(1, deploymentRef.current));
      
      // Interpolate Visual Parameters
      const currentTilt = GROUND_TILT + (FLYING_TILT - GROUND_TILT) * depl;
      const currentBaseY = 20 + (MAX_BASE_OFFSET_Y - 20) * depl;
      const distScale = 0.05 + (0.95) * depl; // Compress length when grounded
      
      // Camera override REMOVED to respect user controls
      // const targetCamY = 2500 * depl + 200;
      // ...

      // --- 3D Transforms with Dynamic Tilt ---
      const transformPointRotation = (p: Point3D): Point3D => {
          const c = Math.cos(currentTilt);
          const s = Math.sin(currentTilt);
          return {
              x: p.x,
              y: p.y * c - p.z * s,
              z: p.y * s + p.z * c
          };
      };

      const getTurbineWorldPos = (local: Point3D): Point3D => {
          const rotated = transformPointRotation(local);
          return {
              x: rotated.x,
              y: rotated.y + currentBaseY, 
              z: rotated.z
          };
      };

      const worldToScreen = (p: Point3D, width: number, height: number): ScreenPoint | null => {
        const cam = cameraState.current;
        let x = p.x - cam.targetX;
        let y = p.y - cam.targetY;
        let z = p.z - cam.targetZ;

        const cosT = Math.cos(cam.theta);
        const sinT = Math.sin(cam.theta);
        const x2 = x * cosT - z * sinT;
        const z2 = x * sinT + z * cosT;

        const cosP = Math.cos(cam.phi);
        const sinP = Math.sin(cam.phi);
        const y3 = y * cosP - z2 * sinP;
        const z3 = y * sinP + z2 * cosP;

        const zFinal = z3 - cam.radius;
        if (zFinal >= 0) return null; 
        
        const scale = fov / (fov - zFinal);
        
        return {
          x: width / 2 + x2 * scale,
          y: height / 2 - y3 * scale, 
          z: zFinal 
        };
      };

      // --- Physics Simulation ---
      
      const bladeCountFactor = (bladeCount - 6) * 0.25;
      const hollowFactor = (1 - (bladeLengthIn / 800)) * 0.5; 
      const lengthFactor = (bladeLengthOut - 380) / 1000 * 0.2; 
      
      const currentOptimalTSR = 4.0 - bladeCountFactor + hollowFactor + lengthFactor;
      physicsState.current.optimalTsr = currentOptimalTSR;
      const currentMaxTSR = TSR_MAX_BASE - bladeCountFactor + hollowFactor + lengthFactor;

      let currentTorque = torque;

      if (isAutoPilot) {
          const error = physicsState.current.tsr - currentOptimalTSR;
          const correction = error * 2.0; 
          let newTorque = currentTorque + correction;
          const MAX_SAFE_TORQUE = 80;
          newTorque = Math.max(0, Math.min(MAX_SAFE_TORQUE, newTorque));
          
          if (Math.abs(newTorque - torque) > 0.5) {
              setTorque(prev => {
                  const step = (newTorque - prev) * 0.1;
                  return prev + step;
              });
              currentTorque = newTorque; 
          }
      }

      const windFactor = Math.max(0.1, envWindSpeed);
      const requiredTorqueForOptimal = Math.pow(windFactor / 12, 2) * 100; 
      const safeRequired = Math.max(1, requiredTorqueForOptimal);
      const brakeRatio = currentTorque / safeRequired;
      
      let targetTSR = currentOptimalTSR;
      
      if (depl < 0.5) {
          targetTSR = 0; // Grounded physics
      } else {
        if (physicsState.current.isRunaway) {
            if (envWindSpeed <= 18) {
                physicsState.current.isRunaway = false;
            } else {
                targetTSR = 6.2; 
            }
        } else {
            if (brakeRatio >= 1.0) {
                targetTSR = currentOptimalTSR - (brakeRatio - 1.0) * 2.0;
                targetTSR = Math.max(0, targetTSR);
            } else {
                targetTSR = currentOptimalTSR + (1.0 - brakeRatio) * (currentMaxTSR - currentOptimalTSR);
                const isPowerSaturated = physicsState.current.kw >= 30;
                if (targetTSR > 5.8 && isPowerSaturated) {
                    physicsState.current.isRunaway = true;
                }
            }
        }
      }

      const inertia = 0.05;
      physicsState.current.tsr += (targetTSR - physicsState.current.tsr) * inertia;
      
      const outerRadiusM = (ROTOR_RADIUS_SCALE + bladeLengthOut) / 100;
      const circumferenceM = 2 * Math.PI * outerRadiusM;
      const tipSpeedMs = physicsState.current.tsr * envWindSpeed;
      physicsState.current.rpm = (tipSpeedMs * 60) / circumferenceM;

      const bladePowerFactor = 1 + ((bladeCount - 6) * 0.1);
      physicsState.current.kw = Math.floor((currentTorque / 100) * (physicsState.current.rpm / 32) * 30 * bladePowerFactor); 
      physicsState.current.kw = Math.min(30, Math.max(0, physicsState.current.kw));

      physicsState.current.overspeedRisk = physicsState.current.tsr > (currentOptimalTSR * 1.3);
      physicsState.current.compressionRisk = currentTorque > 85 && envWindSpeed > 10; 

      const radsPerSec = (physicsState.current.rpm / 60) * 2 * Math.PI;
      rotationRef.current -= radsPerSec * dt; 


      // --- Drawing ---

      ctx.clearRect(0, 0, width, height);

      // Sky
      const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
      skyGrad.addColorStop(0, '#0f172a'); 
      skyGrad.addColorStop(0.6, '#38bdf8'); 
      skyGrad.addColorStop(1, '#e0f2fe'); 
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, width, height);

      const horizonY = height / 2 - fov * Math.tan(cameraState.current.phi);

      // Ground
      if (horizonY < height) {
          ctx.fillStyle = '#3f6212'; 
          ctx.fillRect(0, horizonY, width, height - horizonY);
          const fogHeight = 300;
          if (height - horizonY > 0) {
             const groundFog = ctx.createLinearGradient(0, horizonY, 0, Math.min(height, horizonY + fogHeight));
             groundFog.addColorStop(0, 'rgba(224, 242, 254, 0.4)');
             groundFog.addColorStop(1, 'rgba(63, 98, 18, 0)');
             ctx.fillStyle = groundFog;
             ctx.fillRect(0, horizonY, width, fogHeight);
          }
      }

      // Render Queue
      interface DrawCommand {
          z: number;
          draw: () => void;
      }
      const drawQueue: DrawCommand[] = [];

      // Helpers
      const drawCylinder = (start: Point3D, end: Point3D, radius: number, color: string) => {
        const center = { x: (start.x+end.x)/2, y: (start.y+end.y)/2, z: (start.z+end.z)/2 };
        const sc = worldToScreen(center, width, height);
        if(!sc) return;
        drawQueue.push({
            z: sc.z,
            draw: () => {
                const s1 = worldToScreen(start, width, height);
                const s2 = worldToScreen(end, width, height);
                if (s1 && s2) {
                    ctx.lineCap = 'butt';
                    ctx.lineWidth = (radius * 2) * (fov / (fov - sc.z)); 
                    ctx.strokeStyle = color;
                    ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
                }
            }
        });
      };

      const drawDisk = (center: Point3D, radius: number, normalY: boolean, color: string) => {
          const sc = worldToScreen(center, width, height);
          if(!sc) return;
          const points: Point3D[] = [];
          const segs = 24;
          for(let i=0; i<segs; i++) {
              const theta = (i/segs) * Math.PI * 2;
              points.push({
                  x: center.x + Math.cos(theta) * radius,
                  y: center.y,
                  z: center.z + Math.sin(theta) * radius
              });
          }
          drawQueue.push({
              z: sc.z,
              draw: () => {
                  ctx.fillStyle = color;
                  ctx.beginPath();
                  points.forEach((p, i) => {
                      const s = worldToScreen(p, width, height);
                      if (s) {
                          if (i===0) ctx.moveTo(s.x, s.y);
                          else ctx.lineTo(s.x, s.y);
                      }
                  });
                  ctx.closePath(); ctx.fill();
                  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1; ctx.stroke();
              }
          })
      };

      const drawBox = (center: Point3D, w: number, h: number, d: number, color: string) => {
          const sc = worldToScreen(center, width, height);
          if (!sc) return;
          drawQueue.push({
              z: sc.z,
              draw: () => {
                const hw = w/2, hh = h/2, hd = d/2;
                const corners = [
                    {x: center.x-hw, y: center.y-hh, z: center.z-hd},
                    {x: center.x+hw, y: center.y-hh, z: center.z-hd},
                    {x: center.x+hw, y: center.y+hh, z: center.z-hd},
                    {x: center.x-hw, y: center.y+hh, z: center.z-hd},
                    {x: center.x-hw, y: center.y-hh, z: center.z+hd},
                    {x: center.x+hw, y: center.y-hh, z: center.z+hd},
                    {x: center.x+hw, y: center.y+hh, z: center.z+hd},
                    {x: center.x-hw, y: center.y+hh, z: center.z+hd},
                ].map(p => worldToScreen(p, width, height));
                if (corners.some(c => !c)) return;

                ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1;
                const faces = [[0,1,2,3], [4,5,6,7], [0,1,5,4], [1,2,6,5], [2,3,7,6], [3,0,4,7]];
                const sortedFaces = faces.map(indices => {
                    const z = indices.reduce((acc, idx) => acc + (corners[idx as number]?.z || 0), 0) / 4;
                    return { indices, z };
                }).sort((a,b) => a.z - b.z);

                sortedFaces.forEach(face => {
                    ctx.beginPath();
                    face.indices.forEach((idx, i) => {
                        const p = corners[idx as number];
                        if (p) { if (i===0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); }
                    });
                    ctx.closePath(); ctx.fill(); ctx.stroke();
                });
              }
          });
      };

      // Grid
      ctx.save();
      ctx.beginPath(); ctx.rect(0, horizonY, width, height - horizonY); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
      const gridSize = 1000;
      ctx.beginPath();
      for(let i=-12; i<=12; i++) {
          const s1 = worldToScreen({x: i*gridSize, y: 5, z: -12*gridSize}, width, height);
          const e1 = worldToScreen({x: i*gridSize, y: 5, z: 12*gridSize}, width, height);
          if(s1 && e1) { ctx.moveTo(s1.x, s1.y); ctx.lineTo(e1.x, e1.y); }
          const s2 = worldToScreen({x: -12*gridSize, y: 5, z: i*gridSize}, width, height);
          const e2 = worldToScreen({x: 12*gridSize, y: 5, z: i*gridSize}, width, height);
          if(s2 && e2) { ctx.moveTo(s2.x, s2.y); ctx.lineTo(e2.x, e2.y); }
      }
      ctx.stroke();
      ctx.restore();


      // Ground Station
      const gsYBase = -400; 
      const gsYTop = -20;
      
      drawCylinder({x:0, y: gsYBase, z: 0}, {x:0, y: gsYTop, z:0}, 30, 'rgba(100,116,139, 0.5)'); 
      drawDisk({x:0, y: gsYBase, z:0}, 200, true, 'rgba(100,116,139, 0.5)');
      drawDisk({x:0, y: 5, z:0}, 280, true, '#ef4444');
      drawCylinder({x:0, y: 5, z: 0}, {x:0, y: currentBaseY, z:0}, 60, '#64748b');

      // Motor & Cable
      // Fixed Ground parts:
      drawCylinder({x:0, y: -180, z: 0}, {x:0, y: -20, z: 0}, 90, '#475569');

      // Battery
      const batteryPos = { x: -300, y: 50, z: 200 };
      drawBox(batteryPos, 120, 100, 200, '#334155'); 
      drawBox({ ...batteryPos, y: 105 }, 110, 10, 190, '#10b981'); 

      const cableStart = { x: 0, y: 50, z: 0 };
      const cableEnd = { x: batteryPos.x + 40, y: batteryPos.y + 50, z: batteryPos.z };
      const cableControl = { x: (cableStart.x + cableEnd.x)/2, y: 20, z: (cableStart.z + cableEnd.z)/2 };

      const cs = worldToScreen(cableStart, width, height);
      const ce = worldToScreen(cableEnd, width, height);
      const cc = worldToScreen(cableControl, width, height);
      
      if (cs && ce && cc) {
          drawQueue.push({
              z: cs.z,
              draw: () => {
                  ctx.beginPath(); ctx.moveTo(cs.x, cs.y); ctx.quadraticCurveTo(cc.x, cc.y, ce.x, ce.y);
                  ctx.strokeStyle = '#333'; ctx.lineWidth = 4; ctx.stroke();
                  if (physicsState.current.kw > 0) {
                      ctx.beginPath(); ctx.moveTo(cs.x, cs.y); ctx.quadraticCurveTo(cc.x, cc.y, ce.x, ce.y);
                      ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2; ctx.setLineDash([10, 15]);
                      ctx.lineDashOffset = -Date.now() / 20; ctx.stroke(); ctx.setLineDash([]);
                  }
              }
          });
      }

      if (physicsState.current.kw > 0) {
          const batScreen = worldToScreen({ ...batteryPos, y: 150 }, width, height);
          if (batScreen) {
              drawQueue.push({
                  z: batScreen.z - 100,
                  draw: () => {
                      const scale = 1 + Math.sin(Date.now() / 150) * 0.2;
                      const alpha = 0.5 + Math.sin(Date.now() / 150) * 0.5;
                      ctx.save(); ctx.translate(batScreen.x, batScreen.y); ctx.scale(scale, scale);
                      ctx.fillStyle = `rgba(250, 204, 21, ${alpha})`; ctx.strokeStyle = '#d97706'; ctx.lineWidth = 2;
                      ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(10, 0); ctx.lineTo(5, 0); ctx.lineTo(15, 25); ctx.lineTo(-5, 5); ctx.lineTo(0, 5);
                      ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
                  }
              });
          }
      }

      // Structure
      const structureDefRaw = [
        { y: 0, r: 180, type: 'pto' }, 
        { y: 500, r: 180, type: 'trpt' },
        { y: 1030, r: 180, type: 'trpt' },
        { y: 1560, r: 180, type: 'trpt' },
        { y: 2090, r: 180, type: 'trpt' },
        { y: 2620, r: 180, type: 'trpt' },
        { y: 3150, r: 180, type: 'trpt' },
        { y: 4200, r: 566, type: 'rotor' },
        { y: 5000, r: ROTOR_RADIUS_SCALE, type: 'rotor-main' },
        { y: 5530, r: 566, type: 'rotor' },
        { y: 6000, r: 44, type: 'bearing' },
      ];

      // Apply scale to structure positions
      const structureDef = structureDefRaw.map(s => ({
          ...s,
          y: s.y * distScale
      }));

      const computedLayers: ({ p2: ScreenPoint, angle: number, p3: Point3D } | null)[][] = [];

      structureDef.forEach((layer) => {
         const twistFactor = (currentTorque / 100) * 2.3; 
         // Logic to untwist when grounded?
         const effectiveTwistFactor = twistFactor * depl;
         const effectiveHeight = Math.min(layer.y, 5000 * distScale); 
         const twistAmount = (effectiveHeight / (5000 * distScale || 1)) * effectiveTwistFactor;
         const netTwist = -twistAmount; 

         const points: ({ p2: ScreenPoint, angle: number, p3: Point3D } | null)[] = [];
         
         for (let i = 0; i < bladeCount; i++) {
             const baseAngle = (i / bladeCount) * Math.PI * 2;
             const angle = baseAngle + rotationRef.current + netTwist;
             const localP3: Point3D = { x: Math.cos(angle) * layer.r, y: layer.y, z: Math.sin(angle) * layer.r };
             const worldP3 = getTurbineWorldPos(localP3);
             const p2 = worldToScreen(worldP3, width, height);
             points.push(p2 ? { p2, angle, p3: worldP3 } : null);
         }
         computedLayers.push(points);
      });

      // Lift Kite
      const kiteDist = 9000 * distScale;
      const kiteOscillation = Math.sin(Date.now() * 0.001) * 100 * depl; // Stop oscillation when grounded
      const KITE_CELLS = 4;
      const KITE_SPAN = 800; 
      const KITE_CHORD = 320; 
      const KITE_THICKNESS = 80; 
      const CELL_WIDTH = KITE_SPAN / KITE_CELLS;
      const BRIDLE_OFFSET = 400 * distScale; 
      
      const kiteAnchorLocal = { x: kiteOscillation, y: kiteDist, z: 0 };
      const kiteAnchorP3 = getTurbineWorldPos(kiteAnchorLocal);
      const kiteAnchorS = worldToScreen(kiteAnchorP3, width, height);
      // Bearing center logic needs to use scaled Y
      const bearingCenterP3 = getTurbineWorldPos({ x: 0, y: 6000 * distScale, z: 0 });
      const bearingCenterS = worldToScreen(bearingCenterP3, width, height);

      if (kiteAnchorS) {
          const ribs: {top: ScreenPoint, bottom: ScreenPoint, tail: ScreenPoint}[] = [];
          for (let i = 0; i <= KITE_CELLS; i++) {
              const xOffset = (i * CELL_WIDTH) - (KITE_SPAN / 2);
              const archY = -Math.pow(xOffset / (KITE_SPAN/2), 2) * 80; 
              const pTopS = worldToScreen(getTurbineWorldPos({ x: kiteOscillation + xOffset, y: kiteDist + KITE_THICKNESS + archY, z: -KITE_CHORD/2 }), width, height);
              const pBottomS = worldToScreen(getTurbineWorldPos({ x: kiteOscillation + xOffset, y: kiteDist + archY, z: -KITE_CHORD/2 }), width, height);
              const pTailS = worldToScreen(getTurbineWorldPos({ x: kiteOscillation + xOffset, y: kiteDist + (KITE_THICKNESS/2) + archY, z: KITE_CHORD/2 }), width, height);
              if (pTopS && pBottomS && pTailS) ribs.push({ top: pTopS, bottom: pBottomS, tail: pTailS });
          }

          drawQueue.push({
              z: kiteAnchorS.z,
              draw: () => {
                  if (ribs.length < 2) return;
                  ctx.lineJoin = 'round';
                  ctx.fillStyle = '#fbbf24'; 
                  for (let i=0; i < ribs.length - 1; i++) {
                      const r1 = ribs[i]; const r2 = ribs[i+1];
                      ctx.beginPath(); ctx.moveTo(r1.top.x, r1.top.y); ctx.lineTo(r2.top.x, r2.top.y); ctx.lineTo(r2.tail.x, r2.tail.y); ctx.lineTo(r1.tail.x, r1.tail.y); ctx.closePath(); ctx.fill();
                  }
                  ctx.strokeStyle = '#d97706'; ctx.lineWidth = 1;
                  ribs.forEach(r => { ctx.beginPath(); ctx.moveTo(r.top.x, r.top.y); ctx.lineTo(r.bottom.x, r.bottom.y); ctx.lineTo(r.tail.x, r.tail.y); ctx.stroke(); });
                  ctx.fillStyle = '#fcd34d'; 
                  for (let i=0; i < ribs.length - 1; i++) {
                      const r1 = ribs[i]; const r2 = ribs[i+1];
                      ctx.beginPath(); ctx.moveTo(r1.bottom.x, r1.bottom.y); ctx.lineTo(r2.bottom.x, r2.bottom.y); ctx.lineTo(r2.tail.x, r2.tail.y); ctx.lineTo(r1.tail.x, r1.tail.y); ctx.closePath(); ctx.fill();
                  }
                  ctx.fillStyle = '#78350f'; 
                  for (let i=0; i < ribs.length - 1; i++) {
                      const r1 = ribs[i]; const r2 = ribs[i+1];
                      ctx.beginPath(); ctx.moveTo(r1.top.x, r1.top.y); ctx.lineTo(r2.top.x, r2.top.y); ctx.lineTo(r2.bottom.x, r2.bottom.y); ctx.lineTo(r1.bottom.x, r1.bottom.y); ctx.closePath(); ctx.fill();
                  }
                  const bridlePointS = worldToScreen(getTurbineWorldPos({ x: kiteOscillation, y: kiteDist - BRIDLE_OFFSET, z: 0 }), width, height);
                  if (bridlePointS) {
                      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 0.5;
                      ribs.forEach((r, idx) => { if (idx % 1 === 0) { ctx.beginPath(); ctx.moveTo(r.bottom.x, r.bottom.y); ctx.lineTo(bridlePointS.x, bridlePointS.y); ctx.stroke(); } });
                  }
              }
          });
      }

      if (kiteAnchorS && bearingCenterS) {
          drawQueue.push({
              z: (kiteAnchorS.z + bearingCenterS.z) / 2,
              draw: () => {
                  const bridlePointS = worldToScreen(getTurbineWorldPos({ x: kiteOscillation, y: kiteDist - BRIDLE_OFFSET, z: 0 }), width, height);
                  if (bridlePointS) {
                      ctx.beginPath(); ctx.moveTo(bearingCenterS.x, bearingCenterS.y); ctx.lineTo(bridlePointS.x, bridlePointS.y);
                      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.setLineDash([10, 5]); ctx.stroke(); ctx.setLineDash([]);
                  }
              }
          });
      }

      // Draw Rings & Tethers
      structureDef.forEach((def, lIdx) => {
          if (def.r === 0) return;
          const currentPts = computedLayers[lIdx];
          if (!currentPts) return;

          const centerP3 = getTurbineWorldPos({ x: 0, y: def.y, z: 0 });
          const centerS = worldToScreen(centerP3, width, height);
          
          if (centerS) {
              drawQueue.push({
                  z: centerS.z,
                  draw: () => {
                      ctx.beginPath();
                      let started = false;
                      for(let i=0; i<currentPts.length; i++) {
                          const pt = currentPts[i];
                          if (!pt) continue;
                          if (!started) { ctx.moveTo(pt.p2.x, pt.p2.y); started = true; }
                          else ctx.lineTo(pt.p2.x, pt.p2.y);
                      }
                      if (started) ctx.closePath();

                      if (def.type === 'rotor-main') {
                          ctx.lineWidth = 4; ctx.strokeStyle = '#1e293b'; 
                      } else if (def.type === 'bearing') {
                          ctx.lineWidth = 3; ctx.strokeStyle = '#475569';
                      } else if (def.type === 'pto') {
                          ctx.lineWidth = 0; ctx.fillStyle = '#2563eb'; ctx.fill(); ctx.strokeStyle = '#1e3a8a'; ctx.lineWidth = 2;
                      } else {
                          ctx.lineWidth = 1; ctx.strokeStyle = '#334155';
                      }
                      ctx.stroke();

                      if (def.type === 'pto') {
                          ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
                          currentPts.forEach(p => { if (p) { ctx.beginPath(); ctx.moveTo(centerS.x, centerS.y); ctx.lineTo(p.p2.x, p.p2.y); ctx.stroke(); } });
                      }

                      if (def.type === 'rotor-main') {
                          currentPts.forEach((pt) => {
                             if (!pt) return;
                             const angle = pt.angle;
                             const innerTipS = worldToScreen(getTurbineWorldPos({ x: Math.cos(angle) * (def.r - bladeLengthIn), y: def.y, z: Math.sin(angle) * (def.r - bladeLengthIn) }), width, height);
                             const outerTipS = worldToScreen(getTurbineWorldPos({ x: Math.cos(angle) * (def.r + bladeLengthOut), y: def.y, z: Math.sin(angle) * (def.r + bladeLengthOut) }), width, height);
                             if (innerTipS && outerTipS) {
                                 ctx.beginPath(); ctx.moveTo(innerTipS.x, innerTipS.y); ctx.lineTo(outerTipS.x, outerTipS.y);
                                 ctx.strokeStyle = 'white'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.stroke();
                                 const dx = outerTipS.x - innerTipS.x; const dy = outerTipS.y - innerTipS.y;
                                 const redStart = { x: outerTipS.x - dx * 0.2, y: outerTipS.y - dy * 0.2 };
                                 ctx.beginPath(); ctx.moveTo(redStart.x, redStart.y); ctx.lineTo(outerTipS.x, outerTipS.y);
                                 ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 6; ctx.stroke();
                             }
                          });
                      }
                  }
              });

              const nextLayerPts = computedLayers[lIdx + 1];
              if (nextLayerPts) {
                  const nextDef = structureDef[lIdx + 1];
                  const nextCenterS = worldToScreen(getTurbineWorldPos({ x: 0, y: nextDef.y, z: 0 }), width, height);
                  if (nextCenterS) {
                      drawQueue.push({
                          z: (centerS.z + nextCenterS.z) / 2,
                          draw: () => {
                              ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(50, 50, 50, 0.8)';
                              for (let i = 0; i < bladeCount; i++) {
                                  const pStart = currentPts[i];
                                  const pEnd = nextLayerPts[i];
                                  if (pStart && pEnd) { ctx.beginPath(); ctx.moveTo(pStart.p2.x, pStart.p2.y); ctx.lineTo(pEnd.p2.x, pEnd.p2.y); ctx.stroke(); }
                              }
                          }
                      });
                  }
              }
          }
      });

      drawQueue.sort((a, b) => a.z - b.z);
      drawQueue.forEach(item => item.draw());

      // Labels Update
      if (true) {
        const rotorLayer = computedLayers[8];
        const trptLayer = computedLayers[3];
        
        const getLabelData = (centerY: number, radius: number, targetS: ScreenPoint | undefined, extra?: string): LabelData | null => {
            if (!targetS) return null;
            const centerP3 = getTurbineWorldPos({x: 0, y: centerY, z: 0});
            const centerS = worldToScreen(centerP3, width, height);
            if (!centerS) return null;
            const zFinal = centerS.z; 
            const scale = fov / (fov - zFinal);
            const screenRadius = radius * scale;
            const anchorX = centerS.x + screenRadius + 60;
            const anchorY = centerS.y;
            return { target: { x: targetS.x, y: targetS.y }, anchor: { x: anchorX, y: anchorY }, extraText: extra };
        };

        const rotorPoint = rotorLayer?.find(p => p !== null)?.p2;
        const trptPoint = trptLayer?.find(p => p !== null)?.p2;

        const rotorData = getLabelData(
            5000 * distScale, 
            ROTOR_RADIUS_SCALE + bladeLengthOut, 
            rotorPoint,
            `Outer: ${bladeLengthOut}cm\nInner: ${bladeLengthIn}cm`
        );
        const trptData = getLabelData(2090 * distScale, 180, trptPoint);
        
        const genP3 = {x: 0, y: MAX_BASE_OFFSET_Y/2, z: 0};
        const genS = worldToScreen(genP3, width, height);
        
        let statusColor = "text-green-400";
        if (physicsState.current.tsr < physicsState.current.optimalTsr * 0.6 && envWindSpeed >= 4) statusColor = "text-amber-400"; // Stall
        if (physicsState.current.tsr > physicsState.current.optimalTsr * 1.25) statusColor = "text-red-400"; // Overspeed
        if (physicsState.current.isRunaway) statusColor = "text-red-500 font-bold animate-pulse";
        if (envWindSpeed <= 3) statusColor = "text-red-500"; // Grounded

        const genData: LabelData | null = genS ? { 
            target: {x: genS.x, y: genS.y}, 
            anchor: {x: genS.x + 120, y: genS.y},
            extraText: `${physicsState.current.kw} kW`,
            subText: `Status: ${uiStatus}\nTSR: ${uiTsr}`,
            statusColor: statusColor
        } : null;

        const kiteData = kiteAnchorS ? { target: {x: kiteAnchorS.x, y: kiteAnchorS.y}, anchor: {x: kiteAnchorS.x + 100, y: kiteAnchorS.y} } : null;

        setLabels({ liftKite: kiteData, rotor: rotorData, trpt: trptData, generator: genData });
      }

      frameId.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(frameId.current);
      window.removeEventListener('resize', handleResize);
    };
  }, [torque, bladeCount, bladeLengthOut, bladeLengthIn, envWindSpeed, isAutoPilot, uiStatus, uiTsr, uiRpm]); 


  // --- Controls ---

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseState.current.isDragging = true;
    mouseState.current.isPanning = e.button === 2 || e.shiftKey; 
    mouseState.current.lastX = e.clientX;
    mouseState.current.lastY = e.clientY;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!mouseState.current.isDragging) return;
    const deltaX = e.clientX - mouseState.current.lastX;
    const deltaY = e.clientY - mouseState.current.lastY;

    if (mouseState.current.isPanning) {
        const panFactor = 3;
        const { theta } = cameraState.current;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        cameraState.current.targetX -= deltaX * panFactor * cosT;
        cameraState.current.targetZ += deltaX * panFactor * sinT;
        cameraState.current.targetY += deltaY * panFactor;
    } else {
        cameraState.current.theta += deltaX * 0.005;
        const nextPhi = cameraState.current.phi - deltaY * 0.005; 
        cameraState.current.phi = Math.max(-1.5, Math.min(1.5, nextPhi));
    }
    mouseState.current.lastX = e.clientX;
    mouseState.current.lastY = e.clientY;
  };

  const handleMouseUp = () => {
    mouseState.current.isDragging = false;
    mouseState.current.isPanning = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
      const zoomSpeed = 4;
      cameraState.current.radius = Math.max(200, Math.min(20000, cameraState.current.radius + e.deltaY * zoomSpeed));
  };

  return (
    <div className="relative w-full h-full bg-slate-900">
      <canvas 
        ref={canvasRef} 
        className="w-full h-full block cursor-move"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      
      {/* Grounded Overlay */}
      {uiGrounded && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-slate-900/80 border-2 border-slate-500 p-8 rounded-xl shadow-2xl backdrop-blur-md z-40 text-center animate-fade-in">
            <h2 className="text-3xl font-bold text-sky-400 mb-2">⚠ SYSTEM GROUNDED</h2>
            <div className="w-24 h-1 bg-sky-500 mx-auto my-4 rounded"></div>
            <p className="text-slate-200 text-lg mb-4 font-mono">
                AWAITING RE-LAUNCH
            </p>
            <p className="text-slate-400 text-sm max-w-xs mx-auto">
                Wind speeds are insufficient for flight operations. Turbine has been retrieved.
            </p>
            <div className="mt-6 text-2xl font-bold text-white">
                {envWindSpeed} m/s
            </div>
            <div className="text-xs text-slate-500 uppercase tracking-widest mt-1">Current Wind</div>
        </div>
      )}

      {/* Runaway Critical Alert Overlay */}
      {uiRunaway && !uiGrounded && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-950/90 border-2 border-red-500 p-6 rounded-xl shadow-2xl backdrop-blur-lg z-50 animate-pulse text-center max-w-md">
            <h2 className="text-2xl font-bold text-red-500 mb-2">⚠ REGEN SPEED CONTROL LOST</h2>
            <p className="text-white mb-4">
                Regen limited to protect TRPT and Generator. 
                </p>
                <p>
                The rotor is in overspeed state.
            </p>
            <div className="bg-black/50 p-3 rounded border border-red-500/30">
                <p className="text-red-200 font-bold">
                   REGEN LIMITED: 
                   </p>
                   <p>Until wind speed &le; 18 m/s
                </p>
            </div>
        </div>
      )}

      {/* Physics Control Panel */}
      <div className="absolute top-24 right-6 z-30 bg-slate-800/95 backdrop-blur-md p-5 rounded-xl border border-slate-600 shadow-2xl w-72 pointer-events-auto max-h-[85vh] overflow-y-auto flex flex-col gap-4">
        
        <div className="flex justify-between items-center border-b border-slate-700 pb-2">
            <h3 className="text-white font-bold text-sm">System Controls</h3>
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400 font-bold">{isAutoPilot ? 'AUTO' : 'MANUAL'}</span>
                <button 
                    onClick={() => setIsAutoPilot(!isAutoPilot)}
                    disabled={uiRunaway || uiGrounded}
                    className={`w-10 h-5 rounded-full relative transition-colors ${isAutoPilot ? 'bg-sky-500' : 'bg-slate-600'} ${uiRunaway || uiGrounded ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isAutoPilot ? 'left-6' : 'left-1'}`}></div>
                </button>
            </div>
        </div>

        {/* Safety Alerts */}
        {(physicsState.current.overspeedRisk || physicsState.current.compressionRisk) && !uiRunaway && !uiGrounded && (
            <div className="flex flex-col gap-1">
                {physicsState.current.overspeedRisk && (
                    <div className="bg-red-900/50 border border-red-500/50 text-red-200 text-xs px-2 py-1 rounded animate-pulse font-bold text-center">
                        ⚠ Overspeed control loss risk!
                    </div>
                )}
                {physicsState.current.compressionRisk && (
                    <div className="bg-amber-900/50 border border-amber-500/50 text-amber-200 text-xs px-2 py-1 rounded font-bold text-center">
                        ⚠ TRPT compression risk!
                    </div>
                )}
            </div>
        )}

        {/* Wind */}
        <div className="flex flex-col gap-1">
            <label className="text-slate-300 text-xs flex justify-between">
                <span>Wind Speed</span>
                <span className={`font-mono ${uiRunaway ? 'text-red-500 font-bold' : 'text-sky-400'}`}>{envWindSpeed} m/s</span>
            </label>
            <input 
                type="range" min="0" max="25" 
                value={envWindSpeed} 
                onChange={(e) => setEnvWindSpeed(parseInt(e.target.value))}
                className="w-full accent-teal-500 h-2 bg-slate-600 rounded-lg appearance-none cursor-pointer"
            />
        </div>

        {/* Rotor RPM Gauge (Read Only) */}
        <div className="flex flex-col gap-1">
            <label className="text-slate-300 text-xs flex justify-between">
                <span>Rotor RPM</span>
                <span className="text-slate-400 font-mono">{uiRpm}</span>
            </label>
            <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden relative">
                {/* Scale markers */}
                <div className="absolute left-[83%] top-0 bottom-0 w-[1px] bg-slate-600"></div> {/* 50 RPM */}
                <div 
                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
                    style={{ width: `${Math.min(100, (uiRpm / 60) * 100)}%` }}
                ></div>
            </div>
            <div className="flex justify-between text-[8px] text-slate-500">
                <span>0</span>
                <span>30</span>
                <span>60</span>
            </div>
        </div>

        {/* Tip Speed Ratio Meter */}
        <div className="flex flex-col gap-1">
            <div className="flex justify-between items-end">
                <span className="text-slate-300 text-xs">Tip Speed Ratio (TSR)</span>
                <span className={`text-xs font-mono font-bold ${
                    uiTsr > physicsState.current.optimalTsr * 1.25 ? 'text-red-400' : uiTsr < physicsState.current.optimalTsr * 0.6 ? 'text-amber-400' : 'text-green-400'
                }`}>{uiTsr}</span>
            </div>
            {/* Custom Bar with Zones */}
            <div className="w-full h-3 bg-slate-700 rounded overflow-hidden relative flex">
                <div className="h-full bg-amber-500 w-[33%] opacity-40"></div> {/* Stall Zone */}
                <div className="h-full bg-green-500 w-[33%] opacity-40"></div> {/* Optimal Zone */}
                <div className="h-full bg-red-500 w-[34%] opacity-40"></div>   {/* Overspeed Zone */}
                
                {/* Needle */}
                <div 
                    className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_5px_white] transition-all duration-300"
                    style={{ left: `${Math.min(100, (uiTsr / 8.0) * 100)}%` }}
                ></div>
            </div>
            <div className="flex justify-between text-[9px] text-slate-500 px-1">
                <span>Stall</span>
                <span className="text-green-500">Opt ({physicsState.current.optimalTsr.toFixed(1)})</span>
                <span>Overspeed</span>
            </div>
        </div>

        {/* Torque Control */}
        <div className="flex flex-col gap-1">
            <label className="text-slate-300 text-xs flex justify-between">
                <span>Regen Torque</span>
                <span className="text-amber-400 font-mono">{Math.round(torque)}%</span>
            </label>
            <input 
                type="range" min="0" max="100" 
                value={torque} 
                onChange={(e) => !isAutoPilot && setTorque(parseInt(e.target.value))}
                disabled={isAutoPilot || uiRunaway || uiGrounded}
                className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                    (isAutoPilot || uiRunaway || uiGrounded) ? 'bg-slate-700 accent-slate-500 cursor-not-allowed' : 'bg-slate-600 accent-amber-500'
                }`}
            />
            {isAutoPilot && !uiRunaway && !uiGrounded && <span className="text-[10px] text-sky-500 text-center italic">Auto-adjusting...</span>}
            {uiRunaway && <span className="text-[10px] text-red-500 text-center italic font-bold">CONTROL LOST</span>}
        </div>

        <div className="w-full border-t border-slate-700 my-1"></div>

        {/* Structural Config */}
        <div className="text-slate-400 text-xs">
            <h3 className="text-slate-200 font-bold mb-2">Rotor Design</h3>
            <div className="flex flex-col gap-3 pl-2 border-l border-slate-700">
                <div>
                    <div className="flex justify-between text-[10px] mb-1">
                        <span>Blade Length (Out)</span>
                        <span className="font-mono text-slate-300">{bladeLengthOut} cm</span>
                    </div>
                    <input type="range" min="100" max="1500" value={bladeLengthOut} onChange={(e) => setBladeLengthOut(parseInt(e.target.value))} className="w-full h-1 accent-slate-400 bg-slate-700" />
                </div>
                <div>
                    <div className="flex justify-between text-[10px] mb-1">
                         <span>Blade Length (In)</span>
                         <span className="font-mono text-slate-300">{bladeLengthIn} cm</span>
                    </div>
                    <input type="range" min="0" max="800" value={bladeLengthIn} onChange={(e) => setBladeLengthIn(parseInt(e.target.value))} className="w-full h-1 accent-slate-400 bg-slate-700" />
                </div>
                <div>
                    <span className="block text-[10px] mb-1">Blade Count: {bladeCount} (qty)</span>
                    <input type="range" min="5" max="12" value={bladeCount} onChange={(e) => setBladeCount(parseInt(e.target.value))} className="w-full h-1 accent-slate-400 bg-slate-700" />
                </div>
            </div>
        </div>
        
      </div>

      {/* Labels */}
      {labels.liftKite && <Label data={labels.liftKite} title="Lift Kite" desc="Static parafoil" />}
      {labels.rotor && <Label data={labels.rotor} title="Rotor" desc={`Radius: ${(ROTOR_RADIUS_SCALE/100).toFixed(1)}m`} />}
      {labels.trpt && <Label data={labels.trpt} title="TRPT" desc="Torque transmission" />}
      {labels.generator && <Label data={labels.generator} title="Ground Station" desc={`Power: ${labels.generator.extraText}`} />}
    </div>
  );
};

const Label: React.FC<{ data: LabelData; title: string; desc: string }> = ({ data, title, desc }) => {
    const { target, anchor, subText, extraText, statusColor } = data;
    
    if (anchor.x < -100 || anchor.x > window.innerWidth + 100 || anchor.y < -100 || anchor.y > window.innerHeight + 100) return null;

    return (
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
             <svg className="absolute top-0 left-0 w-full h-full overflow-visible">
                <line x1={anchor.x} y1={anchor.y} x2={target.x} y2={target.y} stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
             </svg>

             <div className="absolute" style={{ left: anchor.x, top: anchor.y, transform: 'translate(0, -50%)' }}>
                <div className="ml-0 bg-black/60 backdrop-blur px-2 py-1 rounded border border-white/20 shadow-lg">
                    <div className="text-sky-300 text-xs font-bold whitespace-nowrap">{title}</div>
                    <div className="text-slate-300 text-[10px] whitespace-nowrap">{desc}</div>
                    {/* Display extraText for Blade Lengths if available */}
                    {extraText && !desc.includes("Power") && (
                        <div className="text-slate-400 text-[9px] mt-1 border-t border-white/10 pt-1 whitespace-pre-wrap font-mono">
                            {extraText}
                        </div>
                    )}
                    {subText && (
                        <div className={`text-[9px] mt-1 border-t border-white/10 pt-1 whitespace-pre-line leading-tight ${statusColor || 'text-slate-400'}`}>
                            {subText}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default KiteTurbineSimulation;