import { parsePhoneNumber } from 'awesome-phonenumber';

// A calling code identifies a country, not a city. Countries with several
// timezones use a documented primary default; the API still accepts an
// explicit IANA timezone when the caller knows a more precise location.
const countryTimezone: Record<string, string> = {
  AE: 'Asia/Dubai', AF: 'Asia/Kabul', AL: 'Europe/Tirane', AM: 'Asia/Yerevan', AR: 'America/Argentina/Buenos_Aires',
  AT: 'Europe/Vienna', AU: 'Australia/Sydney', AZ: 'Asia/Baku', BA: 'Europe/Sarajevo', BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels', BG: 'Europe/Sofia', BH: 'Asia/Bahrain', BO: 'America/La_Paz', BR: 'America/Sao_Paulo',
  BY: 'Europe/Minsk', CA: 'America/Toronto', CH: 'Europe/Zurich', CL: 'America/Santiago', CN: 'Asia/Shanghai',
  CO: 'America/Bogota', CV: 'Atlantic/Cape_Verde', CY: 'Asia/Nicosia', CZ: 'Europe/Prague', DE: 'Europe/Berlin',
  DK: 'Europe/Copenhagen', DZ: 'Africa/Algiers', EE: 'Europe/Tallinn', EG: 'Africa/Cairo', ES: 'Europe/Madrid',
  ET: 'Africa/Addis_Ababa', FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji', FR: 'Europe/Paris', GB: 'Europe/London',
  GE: 'Asia/Tbilisi', GH: 'Africa/Accra', GR: 'Europe/Athens', GT: 'America/Guatemala', HK: 'Asia/Hong_Kong',
  HR: 'Europe/Zagreb', HU: 'Europe/Budapest', ID: 'Asia/Jakarta', IE: 'Europe/Dublin', IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', IT: 'Europe/Rome', JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi', KR: 'Asia/Seoul', KW: 'Asia/Kuwait', KZ: 'Asia/Almaty', LK: 'Asia/Colombo',
  LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga', MA: 'Africa/Casablanca', MM: 'Asia/Yangon',
  MN: 'Asia/Ulaanbaatar', MX: 'America/Mexico_City', MY: 'Asia/Kuala_Lumpur', NG: 'Africa/Lagos', NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo', NP: 'Asia/Kathmandu', NZ: 'Pacific/Auckland', OM: 'Asia/Muscat', PE: 'America/Lima',
  PH: 'Asia/Manila', PK: 'Asia/Karachi', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon', QA: 'Asia/Qatar',
  RO: 'Europe/Bucharest', RS: 'Europe/Belgrade', RU: 'Europe/Moscow', SA: 'Asia/Riyadh', SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore', SI: 'Europe/Ljubljana', SK: 'Europe/Bratislava', TH: 'Asia/Bangkok', TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei', TZ: 'Africa/Dar_es_Salaam', UA: 'Europe/Kyiv', UG: 'Africa/Kampala', US: 'America/New_York',
  UY: 'America/Montevideo', UZ: 'Asia/Tashkent', VE: 'America/Caracas', VN: 'Asia/Ho_Chi_Minh', ZA: 'Africa/Johannesburg',
  ZW: 'Africa/Harare'
};

export function timezoneFromPhone(phone: string): { timezone: string; regionCode: string } | null {
  try {
    const parsed = parsePhoneNumber(phone.startsWith('+') ? phone : `+${phone}`);
    const regionCode = parsed.valid ? parsed.regionCode?.toUpperCase() : undefined;
    const timezone = regionCode ? countryTimezone[regionCode] : undefined;
    return regionCode && timezone ? { timezone, regionCode } : null;
  } catch {
    return null;
  }
}
