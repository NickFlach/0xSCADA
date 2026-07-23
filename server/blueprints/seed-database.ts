import { storage } from "../storage";
import {
  defaultDataTypeMappings,
  defaultVendors,
} from "./seed-vendors";

type SeedStorage = Pick<
  typeof storage,
  "upsertVendor" | "upsertDataTypeMapping"
>;

export interface BlueprintSeedResult {
  vendors: number;
  dataTypeMappings: number;
}

export async function seedBlueprintDatabase(
  target: SeedStorage = storage,
): Promise<BlueprintSeedResult> {
  let mappingCount = 0;

  for (const vendorInput of defaultVendors) {
    const vendor = await target.upsertVendor(vendorInput);
    const mappings = defaultDataTypeMappings[vendor.name] ?? [];
    for (const mapping of mappings) {
      await target.upsertDataTypeMapping({
        ...mapping,
        vendorId: vendor.id,
      });
      mappingCount += 1;
    }
  }

  return {
    vendors: defaultVendors.length,
    dataTypeMappings: mappingCount,
  };
}
