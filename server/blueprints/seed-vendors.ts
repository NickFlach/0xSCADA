import type {
  InsertDataTypeMapping,
  InsertVendor,
} from "@shared/schema";

export const defaultVendors: InsertVendor[] = [
  {
    name: "siemens",
    displayName: "Siemens",
    description: "Siemens Industrial Automation - TIA Portal and S7 PLCs",
    platforms: ["TIA Portal", "STEP 7", "WinCC"],
    languages: ["SCL", "LAD", "FBD", "STL", "GRAPH"],
    configSchema: {
      plcTypes: ["S7-300", "S7-400", "S7-1200", "S7-1500"],
      communicationProtocols: ["PROFINET", "PROFIBUS", "MPI"],
    },
    isActive: true,
  },
  {
    name: "rockwell",
    displayName: "Rockwell Automation",
    description: "Rockwell Automation - Studio 5000 and Logix controllers",
    platforms: ["Studio 5000", "RSLogix 5000", "FactoryTalk"],
    languages: ["Ladder", "ST", "FBD", "SFC", "AOI"],
    configSchema: {
      plcTypes: ["ControlLogix", "CompactLogix", "MicroLogix"],
      communicationProtocols: ["EtherNet/IP", "ControlNet", "DeviceNet"],
    },
    isActive: true,
  },
  {
    name: "abb",
    displayName: "ABB",
    description: "ABB Industrial Automation - AC500 and AC800M",
    platforms: ["Automation Builder", "Freelance", "800xA"],
    languages: ["ST", "LAD", "FBD", "IL", "CFC"],
    configSchema: {
      plcTypes: ["AC500", "AC500-eCo", "AC500-XC"],
      dcsTypes: ["AC800M", "AC800F"],
    },
    isActive: true,
  },
  {
    name: "emerson",
    displayName: "Emerson",
    description: "Emerson Automation Solutions - DeltaV and Ovation",
    platforms: ["DeltaV", "Ovation", "PACSystems"],
    languages: ["ST", "FBD", "SFC", "CFC"],
    configSchema: {
      dcsTypes: ["DeltaV S-series", "DeltaV M-series"],
      communicationProtocols: ["Foundation Fieldbus", "HART", "WirelessHART"],
    },
    isActive: true,
  },
  {
    name: "schneider",
    displayName: "Schneider Electric",
    description: "Schneider Electric - EcoStruxure and Modicon",
    platforms: ["EcoStruxure Control Expert", "Unity Pro", "SoMachine"],
    languages: ["ST", "LAD", "FBD", "IL", "SFC"],
    configSchema: {
      plcTypes: ["Modicon M340", "Modicon M580", "Modicon Quantum"],
      communicationProtocols: ["Modbus TCP", "Modbus RTU", "EtherNet/IP"],
    },
    isActive: true,
  },
];

type VendorMapping = Omit<
  InsertDataTypeMapping,
  "id" | "vendorId" | "createdAt"
>;

const canonicalTypes = [
  "Bool",
  "Int",
  "DInt",
  "Real",
  "LReal",
  "String",
  "Time",
  "Date",
  "DateTime",
  "Word",
  "DWord",
  "Byte",
] as const;

function directMappings(
  overrides: Partial<Record<(typeof canonicalTypes)[number], string>>,
): VendorMapping[] {
  return canonicalTypes.map((canonicalType) => ({
    canonicalType,
    vendorType: overrides[canonicalType] ?? canonicalType,
  }));
}

export const defaultDataTypeMappings: Record<string, VendorMapping[]> = {
  siemens: directMappings({ DateTime: "Date_And_Time" }),
  rockwell: directMappings({
    Bool: "BOOL",
    Int: "INT",
    DInt: "DINT",
    Real: "REAL",
    LReal: "LREAL",
    String: "STRING",
    Time: "TIMER",
    Date: "DATE",
    DateTime: "DATE_AND_TIME",
    Word: "INT",
    DWord: "DINT",
    Byte: "SINT",
  }),
  abb: directMappings({
    Bool: "BOOL",
    Int: "INT",
    DInt: "DINT",
    Real: "REAL",
    LReal: "LREAL",
    String: "STRING",
    Time: "TIME",
    Date: "DATE",
    DateTime: "DATE_AND_TIME",
    Word: "WORD",
    DWord: "DWORD",
    Byte: "BYTE",
  }),
};
