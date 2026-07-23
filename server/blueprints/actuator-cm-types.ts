/**
 * Control Module Type Definitions for Common Industrial Actuators
 * 
 * Following ISA-88 standards and IEC 61131-3 data types.
 * 
 * Naming Conventions (ISA-88):
 * - XV_  : On/Off Valve (XV = eXtended Valve)
 * - FCV_ : Flow Control Valve (Modulating)
 * - MOT_ : Motor Starter
 * - VSD_ : Variable Speed Drive
 * 
 * Standard Signal Types:
 * - Commands: Boolean outputs to actuator (Open, Close, Start, Stop)
 * - Feedback: Boolean inputs from actuator (Opened, Closed, Running, Fault)
 * - Interlocks: Boolean inputs for safety permissives
 * - Analog: Real values for position/speed setpoints and feedback
 */

import type { ParsedCMType } from "./types";

/**
 * XV_OnOffValve - Discrete On/Off Valve Control Module
 * 
 * Standard I/O for block valves, isolation valves, and other two-position valves.
 * Includes open/close commands, position feedback, and interlock signals.
 */
export const XV_OnOffValve: ParsedCMType = {
  name: "XV_OnOffValve",
  inputs: [
    // Commands (from higher-level control)
    {
      name: "CMD_Open",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Command to open valve",
      primary: true,
    },
    {
      name: "CMD_Close",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Command to close valve",
    },
    // Interlocks
    {
      name: "Interlock_OK",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Process interlock permissive (1=OK to operate)",
    },
    // Configuration
    {
      name: "CFG_OpenTime",
      dataType: "TIME",
      ioType: "Config",
      comment: "Maximum time allowed for valve to open (for failure detection)",
      configurable: true,
    },
    {
      name: "CFG_CloseTime",
      dataType: "TIME",
      ioType: "Config",
      comment: "Maximum time allowed for valve to close (for failure detection)",
      configurable: true,
    },
  ],
  outputs: [
    // Physical outputs to valve
    {
      name: "OUT_Open",
      dataType: "BOOL",
      ioType: "DO",
      comment: "Digital output - Open solenoid/actuator",
      primary: true,
    },
    {
      name: "OUT_Close",
      dataType: "BOOL",
      ioType: "DO",
      comment: "Digital output - Close solenoid/actuator",
    },
    // Status
    {
      name: "STS_Opening",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve is transitioning to open",
    },
    {
      name: "STS_Closing",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve is transitioning to closed",
    },
    {
      name: "STS_Open",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve is fully open",
    },
    {
      name: "STS_Closed",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve is fully closed",
    },
    // Alarms
    {
      name: "ALM_FailToOpen",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve failed to reach open position within CFG_OpenTime",
      isError: true,
    },
    {
      name: "ALM_FailToClose",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve failed to reach closed position within CFG_CloseTime",
      isError: true,
    },
    {
      name: "ALM_Interlocked",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve operation blocked by interlock",
    },
  ],
  inOuts: [
    // Physical inputs from valve
    {
      name: "FB_Opened",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Valve open limit switch feedback",
    },
    {
      name: "FB_Closed",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Valve closed limit switch feedback",
    },
  ],
};

/**
 * FCV_ModulatingValve - Analog Modulating Valve Control Module
 * 
 * Standard I/O for control valves with analog position control.
 * Includes setpoint, analog output, position feedback, and limit alarms.
 */
export const FCV_ModulatingValve: ParsedCMType = {
  name: "FCV_ModulatingValve",
  inputs: [
    // Setpoint
    {
      name: "SP",
      dataType: "REAL",
      ioType: "Internal",
      comment: "Valve position setpoint (0-100%)",
      primary: true,
    },
    // Commands
    {
      name: "CMD_Enable",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Enable valve output (1=enabled)",
    },
    {
      name: "CMD_FailPosition",
      dataType: "REAL",
      ioType: "Config",
      comment: "Position to drive to on failure/disable (0-100%)",
      configurable: true,
    },
    // Interlocks
    {
      name: "Interlock_OK",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Process interlock permissive",
    },
    // Configuration
    {
      name: "CFG_RangeMin",
      dataType: "REAL",
      ioType: "Config",
      comment: "Minimum output value (engineering units)",
      configurable: true,
    },
    {
      name: "CFG_RangeMax",
      dataType: "REAL",
      ioType: "Config",
      comment: "Maximum output value (engineering units)",
      configurable: true,
    },
    {
      name: "CFG_Deadband",
      dataType: "REAL",
      ioType: "Config",
      comment: "Feedback deadband for in-position detection (%)",
      configurable: true,
    },
    {
      name: "CFG_StrokeTime",
      dataType: "TIME",
      ioType: "Config",
      comment: "Expected full stroke time (for deviation detection)",
      configurable: true,
    },
  ],
  outputs: [
    // Physical output
    {
      name: "OUT_Position",
      dataType: "REAL",
      ioType: "AO",
      comment: "Analog output - Valve position command (4-20mA / 0-10V)",
      primary: true,
    },
    // Status
    {
      name: "STS_InPosition",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Feedback matches setpoint within deadband",
    },
    {
      name: "STS_Moving",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve is moving toward setpoint",
    },
    {
      name: "STS_AtMin",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve at minimum position",
    },
    {
      name: "STS_AtMax",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve at maximum position",
    },
    // Deviation
    {
      name: "Deviation",
      dataType: "REAL",
      ioType: "Internal",
      comment: "Difference between setpoint and feedback (%)",
    },
    // Alarms
    {
      name: "ALM_DevHigh",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Deviation exceeds high limit",
      isError: true,
    },
    {
      name: "ALM_FailedToMove",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve did not respond to setpoint change",
      isError: true,
    },
    {
      name: "ALM_Interlocked",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Valve operation blocked by interlock",
    },
  ],
  inOuts: [
    // Physical input
    {
      name: "FB_Position",
      dataType: "REAL",
      ioType: "AI",
      comment: "Analog input - Valve position feedback (4-20mA / 0-10V)",
    },
  ],
};

/**
 * MOT_MotorStarter - Basic Motor Starter Control Module
 * 
 * Standard I/O for DOL (Direct On-Line) motor starters.
 * Includes start/stop commands, running/fault feedback, and current monitoring.
 */
export const MOT_MotorStarter: ParsedCMType = {
  name: "MOT_MotorStarter",
  inputs: [
    // Commands
    {
      name: "CMD_Start",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Command to start motor",
      primary: true,
    },
    {
      name: "CMD_Stop",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Command to stop motor",
    },
    {
      name: "CMD_Reset",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Reset motor protection fault",
    },
    // Interlocks
    {
      name: "Interlock_OK",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Process interlock permissive",
    },
    // Configuration
    {
      name: "CFG_StartDelay",
      dataType: "TIME",
      ioType: "Config",
      comment: "Delay after start command before checking running feedback",
      configurable: true,
    },
    {
      name: "CFG_StopDelay",
      dataType: "TIME",
      ioType: "Config",
      comment: "Delay after stop command before declaring stopped",
      configurable: true,
    },
    {
      name: "CFG_RunTime_Max",
      dataType: "TIME",
      ioType: "Config",
      comment: "Maximum continuous run time (0 = no limit)",
      configurable: true,
    },
  ],
  outputs: [
    // Physical output
    {
      name: "OUT_Run",
      dataType: "BOOL",
      ioType: "DO",
      comment: "Digital output - Motor contactor command",
      primary: true,
    },
    // Status
    {
      name: "STS_Starting",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor is starting (waiting for run feedback)",
    },
    {
      name: "STS_Running",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor is running",
    },
    {
      name: "STS_Stopping",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor is stopping",
    },
    {
      name: "STS_Stopped",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor is stopped",
    },
    {
      name: "STS_Ready",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor is ready to start (no faults, interlocks OK)",
    },
    // Runtime tracking
    {
      name: "RunTime_Total",
      dataType: "TIME",
      ioType: "Internal",
      comment: "Total accumulated run time",
    },
    {
      name: "Starts_Total",
      dataType: "DINT",
      ioType: "Internal",
      comment: "Total number of starts",
    },
    // Alarms
    {
      name: "ALM_FailToStart",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor did not reach running state after start command",
      isError: true,
    },
    {
      name: "ALM_FailToStop",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor did not stop after stop command",
      isError: true,
    },
    {
      name: "ALM_Tripped",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor protection tripped",
      isError: true,
    },
    {
      name: "ALM_Interlocked",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Motor start blocked by interlock",
    },
  ],
  inOuts: [
    // Physical inputs
    {
      name: "FB_Running",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Motor running feedback (aux contact)",
    },
    {
      name: "FB_Tripped",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Motor protection tripped (overload/fault)",
    },
    {
      name: "FB_Current",
      dataType: "REAL",
      ioType: "AI",
      comment: "Analog input - Motor current (Amps)",
    },
  ],
};

/**
 * VSD_VariableSpeedDrive - Variable Speed Drive Control Module
 * 
 * Standard I/O for VFD/inverter controlled motors.
 * Includes speed setpoint, direction control, and comprehensive feedback.
 */
export const VSD_VariableSpeedDrive: ParsedCMType = {
  name: "VSD_VariableSpeedDrive",
  inputs: [
    // Speed control
    {
      name: "SP_Speed",
      dataType: "REAL",
      ioType: "Internal",
      comment: "Speed setpoint (0-100% or RPM based on CFG)",
      primary: true,
    },
    // Commands
    {
      name: "CMD_Run",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Command to run drive",
    },
    {
      name: "CMD_Forward",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Direction - Forward (1) or Reverse (0)",
    },
    {
      name: "CMD_Reset",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Reset drive fault",
    },
    // Interlocks
    {
      name: "Interlock_OK",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Process interlock permissive",
    },
    // Configuration
    {
      name: "CFG_AccelTime",
      dataType: "TIME",
      ioType: "Config",
      comment: "Acceleration time (0-100%)",
      configurable: true,
    },
    {
      name: "CFG_DecelTime",
      dataType: "TIME",
      ioType: "Config",
      comment: "Deceleration time (100-0%)",
      configurable: true,
    },
    {
      name: "CFG_MinSpeed",
      dataType: "REAL",
      ioType: "Config",
      comment: "Minimum speed limit (%)",
      configurable: true,
    },
    {
      name: "CFG_MaxSpeed",
      dataType: "REAL",
      ioType: "Config",
      comment: "Maximum speed limit (%)",
      configurable: true,
    },
    {
      name: "CFG_RatedSpeed",
      dataType: "REAL",
      ioType: "Config",
      comment: "Motor rated speed (RPM) for display",
      configurable: true,
    },
  ],
  outputs: [
    // Physical outputs
    {
      name: "OUT_Run",
      dataType: "BOOL",
      ioType: "DO",
      comment: "Digital output - Drive run command",
      primary: true,
    },
    {
      name: "OUT_Forward",
      dataType: "BOOL",
      ioType: "DO",
      comment: "Digital output - Direction forward",
    },
    {
      name: "OUT_SpeedRef",
      dataType: "REAL",
      ioType: "AO",
      comment: "Analog output - Speed reference (4-20mA / 0-10V)",
    },
    // Status
    {
      name: "STS_Running",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive is running",
    },
    {
      name: "STS_AtSpeed",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Actual speed matches setpoint",
    },
    {
      name: "STS_Accelerating",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive is accelerating",
    },
    {
      name: "STS_Decelerating",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive is decelerating",
    },
    {
      name: "STS_Ready",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive is ready to run (no faults)",
    },
    // Calculated values
    {
      name: "Speed_Actual_RPM",
      dataType: "REAL",
      ioType: "Internal",
      comment: "Calculated actual speed in RPM",
    },
    // Alarms
    {
      name: "ALM_Fault",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive has faulted",
      isError: true,
    },
    {
      name: "ALM_Overload",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive overload condition",
      isError: true,
    },
    {
      name: "ALM_SpeedDeviation",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Actual speed deviates from setpoint",
    },
    {
      name: "ALM_Interlocked",
      dataType: "BOOL",
      ioType: "Internal",
      comment: "Drive blocked by interlock",
    },
  ],
  inOuts: [
    // Physical inputs
    {
      name: "FB_Running",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Drive running feedback",
    },
    {
      name: "FB_Fault",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Drive fault",
    },
    {
      name: "FB_Ready",
      dataType: "BOOL",
      ioType: "DI",
      comment: "Digital input - Drive ready",
    },
    {
      name: "FB_Speed",
      dataType: "REAL",
      ioType: "AI",
      comment: "Analog input - Speed feedback (4-20mA / 0-10V)",
    },
    {
      name: "FB_Current",
      dataType: "REAL",
      ioType: "AI",
      comment: "Analog input - Motor current (Amps)",
    },
    {
      name: "FB_Torque",
      dataType: "REAL",
      ioType: "AI",
      comment: "Analog input - Motor torque (%)",
    },
  ],
};

/**
 * All actuator control module types
 */
export const ACTUATOR_CM_TYPES: ParsedCMType[] = [
  XV_OnOffValve,
  FCV_ModulatingValve,
  MOT_MotorStarter,
  VSD_VariableSpeedDrive,
];

/**
 * Get actuator CM type by name
 */
export function getActuatorCMType(name: string): ParsedCMType | undefined {
  return ACTUATOR_CM_TYPES.find(cm => cm.name === name);
}

/**
 * Get all actuator CM type names
 */
export function getActuatorCMTypeNames(): string[] {
  return ACTUATOR_CM_TYPES.map(cm => cm.name);
}
