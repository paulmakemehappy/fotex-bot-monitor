import { existsSync, readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { Address, Profile } from "./types";

const REQUIRED_COLUMNS = [
  "profile",
  "name",
  "street",
  "postalCode",
  "city",
  "country",
  "mobile",
  "email",
  "cardNumber",
  "cardVerificationCode",
  "expiryMonth",
  "expiryYear",
  "cardholderName"
] as const;

type RawProfileRow = {
  [key: string]: string | undefined;
};

export class ProfileBook {
  static fromCsv(path: string): ProfileBook {
    if (!existsSync(path)) {
      throw new Error(`Profile CSV not found: ${path}`);
    }

    const raw = readFileSync(path, "utf8");
    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as RawProfileRow[];

    if (rows.length === 0) {
      throw new Error(`Profile CSV must include at least one profile row: ${path}`);
    }

    const firstHeader = raw.split(/\r?\n/, 1)[0]?.split(",")[0]?.trim().toLowerCase();
    if (firstHeader !== "profile") {
      throw new Error(`Profile CSV must have 'profile' as the first column in ${path}`);
    }

    for (const column of REQUIRED_COLUMNS) {
      if (!(column in rows[0])) {
        throw new Error(`Profile CSV is missing required column '${column}' in ${path}`);
      }
    }

    const profiles = new Map<string, Profile>();
    for (const [index, row] of rows.entries()) {
      const profileId = requireValue(row.profile, "profile", index);
      profiles.set(profileId, {
        profileId,
        address: mapAddress(row, index),
        card: {
          cardNumber: requireValue(row.cardNumber, "cardNumber", index),
          cardVerificationCode: requireValue(row.cardVerificationCode, "cardVerificationCode", index),
          expiryMonth: requireValue(row.expiryMonth, "expiryMonth", index),
          expiryYear: requireValue(row.expiryYear, "expiryYear", index),
          cardholderName: requireValue(row.cardholderName, "cardholderName", index)
        }
      });
    }

    return new ProfileBook(path, profiles);
  }

  constructor(
    private readonly sourcePath: string,
    private readonly profiles: Map<string, Profile>
  ) {}

  getProfile(profileId: string): Profile {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(
        `Profile '${profileId}' not found in ${this.sourcePath}. Available profiles: ${Array.from(this.profiles.keys()).join(", ")}`
      );
    }

    return profile;
  }
}

function mapAddress(row: RawProfileRow, rowIndex: number): Address {
  return {
    name: requireValue(row.name, "name", rowIndex),
    street: requireValue(row.street, "street", rowIndex),
    postalCode: requireValue(row.postalCode, "postalCode", rowIndex),
    city: requireValue(row.city, "city", rowIndex),
    country: requireValue(row.country, "country", rowIndex),
    mobile: requireValue(row.mobile, "mobile", rowIndex),
    email: requireValue(row.email, "email", rowIndex)
  };
}

function requireValue(value: string | undefined, field: string, rowIndex: number): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Profile CSV row ${rowIndex + 2} is missing '${field}'`);
  }

  return normalized;
}
