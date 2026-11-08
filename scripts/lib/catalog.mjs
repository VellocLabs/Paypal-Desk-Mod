/**
 * The demo store's catalog and buyer geography: 33 consumer-electronics
 * accessories in six categories, and eight countries with their share of
 * orders. Every product sells to the same country mix. `weight` is a product's relative popularity (a long tail: the top
 * ten sell about two thirds of the units); `refund` scales its refund rate.
 * Prices are USD; CALENDAR holds the store's dated events.
 */

export const CATALOG = [
  { sku: 'PWR-20K', name: '20,000 mAh power bank', price: 39, category: 'Charging & power', weight: 11 },
  { sku: 'PWR-10K', name: '10,000 mAh magnetic power bank', price: 29, category: 'Charging & power', weight: 22 },
  { sku: 'CHG-3IN1', name: '3-in-1 wireless charger', price: 45, category: 'Charging & power', weight: 6 },
  { sku: 'CHG-65W', name: '65W GaN USB-C charger', price: 35, category: 'Charging & power', weight: 24 },
  { sku: 'CHG-PAD', name: '15W wireless charging pad', price: 19, category: 'Charging & power', weight: 8 },
  { sku: 'CHG-CAR', name: 'Dual USB-C car charger', price: 15, category: 'Charging & power', weight: 4 },
  { sku: 'CAB-C2C', name: 'USB-C to USB-C cable, 2 m', price: 12, category: 'Cables & hubs', weight: 30 },
  { sku: 'CAB-C2L', name: 'USB-C to Lightning cable, 1 m', price: 12, category: 'Cables & hubs', weight: 8 },
  { sku: 'CAB-3PK', name: 'Braided cable 3-pack', price: 19, category: 'Cables & hubs', weight: 10 },
  { sku: 'HUB-7IN1', name: 'USB-C 7-in-1 hub', price: 59, category: 'Cables & hubs', weight: 7, refund: 1.5 },
  { sku: 'HUB-DOCK', name: 'Thunderbolt dock', price: 189, category: 'Cables & hubs', weight: 0.5, refund: 2 },
  { sku: 'HUB-HDMI', name: 'USB-C to HDMI adapter', price: 19, category: 'Cables & hubs', weight: 4 },
  { sku: 'AUD-BUDS', name: 'Noise-cancelling earbuds', price: 129, category: 'Audio', weight: 13, refund: 2.5 },
  { sku: 'AUD-OPEN', name: 'Open-ear sport earbuds', price: 79, category: 'Audio', weight: 1.5, refund: 2 },
  { sku: 'AUD-HEAD', name: 'Over-ear wireless headphones', price: 159, category: 'Audio', weight: 2.5, refund: 1.5 },
  { sku: 'AUD-SPK', name: 'Portable Bluetooth speaker', price: 49, category: 'Audio', weight: 4 },
  { sku: 'AUD-CASE', name: 'Earbuds silicone case', price: 9, category: 'Audio', weight: 5 },
  { sku: 'KEY-LOW', name: 'Low-profile mechanical keyboard', price: 149, category: 'Input', weight: 0.8, refund: 1.5 },
  { sku: 'KEY-COMP', name: 'Compact 75% keyboard', price: 99, category: 'Input', weight: 2 },
  { sku: 'MOU-ERGO', name: 'Ergonomic wireless mouse', price: 59, category: 'Input', weight: 5 },
  { sku: 'MOU-TRAV', name: 'Travel mouse', price: 29, category: 'Input', weight: 2.5 },
  { sku: 'KEY-CAPS', name: 'PBT keycap set', price: 35, category: 'Input', weight: 1.2 },
  { sku: 'DSK-STAND', name: 'Aluminum laptop stand', price: 49, category: 'Desk', weight: 6 },
  { sku: 'DSK-MAT', name: 'Felt desk mat', price: 29, category: 'Desk', weight: 3 },
  { sku: 'DSK-ARM', name: 'Monitor arm', price: 89, category: 'Desk', weight: 1.5 },
  { sku: 'DSK-CABLE', name: 'Cable organizer kit', price: 15, category: 'Desk', weight: 2.5 },
  { sku: 'DSK-RISER', name: 'Wooden monitor riser', price: 59, category: 'Desk', weight: 1 },
  { sku: 'DSK-HOOK', name: 'Under-desk headphone hook', price: 12, category: 'Desk', weight: 0.8 },
  { sku: 'PHN-CASE', name: 'Phone case with stand', price: 25, category: 'Phone & camera', weight: 14 },
  { sku: 'PHN-GLASS', name: 'Screen protector 2-pack', price: 15, category: 'Phone & camera', weight: 16 },
  { sku: 'PHN-MOUNT', name: 'Magnetic phone mount', price: 25, category: 'Phone & camera', weight: 3 },
  { sku: 'CAM-LIGHT', name: 'Webcam key light', price: 35, category: 'Phone & camera', weight: 1 },
  { sku: 'CAM-1080', name: '1080p webcam', price: 69, category: 'Phone & camera', weight: 2 },
]

export const COUNTRIES = [
  {
    code: 'US', share: 60,
    first: ['James', 'Emily', 'Michael', 'Olivia', 'Daniel', 'Sophia', 'Ryan', 'Ava', 'Ethan', 'Mia', 'Noah', 'Chloe'],
    last: ['Smith', 'Johnson', 'Brown', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Moore', 'Taylor', 'Clark', 'Lewis', 'Walker'],
    streets: ['Market Street', 'Oak Avenue', 'Maple Drive', 'Pine Street', 'Cedar Lane', 'Elm Street'],
    places: [
      { city: 'San Francisco', state: 'CA', postal: '94103' },
      { city: 'New York', state: 'NY', postal: '10001' },
      { city: 'Austin', state: 'TX', postal: '78701' },
      { city: 'Seattle', state: 'WA', postal: '98101' },
      { city: 'Chicago', state: 'IL', postal: '60601' },
      { city: 'Miami', state: 'FL', postal: '33101' },
      { city: 'Boston', state: 'MA', postal: '02108' },
      { city: 'Denver', state: 'CO', postal: '80202' },
    ],
  },
  {
    code: 'CA', share: 16,
    first: ['Liam', 'Emma', 'Lucas', 'Charlotte', 'Benjamin', 'Amelia', 'Owen', 'Hannah'],
    last: ['Tremblay', 'Martin', 'Roy', 'Wong', 'Campbell', 'Anderson', 'Gagnon', 'MacDonald'],
    streets: ['King Street West', 'Granville Street', 'Rue Sainte-Catherine', 'Stephen Avenue'],
    places: [
      { city: 'Toronto', state: 'ON', postal: 'M5V 2T6' },
      { city: 'Vancouver', state: 'BC', postal: 'V6B 1A1' },
      { city: 'Montreal', state: 'QC', postal: 'H2X 1Y4' },
      { city: 'Calgary', state: 'AB', postal: 'T2P 1J9' },
    ],
  },
  {
    code: 'GB', share: 10,
    first: ['Oliver', 'Amelia', 'George', 'Isla', 'Harry', 'Poppy', 'Jack', 'Freya'],
    last: ['Jones', 'Williams', 'Evans', 'Thomas', 'Roberts', 'Hughes', 'Wright', 'Patel'],
    streets: ['High Street', 'Station Road', 'Church Lane', 'Victoria Road'],
    places: [
      { city: 'London', postal: 'EC1A 1BB' },
      { city: 'Manchester', postal: 'M1 1AE' },
      { city: 'Edinburgh', postal: 'EH1 1YZ' },
      { city: 'Bristol', postal: 'BS1 4DJ' },
    ],
  },
  {
    code: 'AU', share: 5,
    first: ['Jack', 'Matilda', 'Cooper', 'Ruby', 'Hudson', 'Zoe'],
    last: ['Nguyen', 'Kelly', 'Mitchell', 'Ryan', 'Harris', 'King'],
    streets: ['George Street', 'Collins Street', 'Queen Street'],
    places: [
      { city: 'Sydney', state: 'NSW', postal: '2000' },
      { city: 'Melbourne', state: 'VIC', postal: '3000' },
      { city: 'Brisbane', state: 'QLD', postal: '4000' },
    ],
  },
  {
    code: 'DE', share: 5,
    first: ['Lukas', 'Mia', 'Felix', 'Lena', 'Jonas', 'Lea'],
    last: ['Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Wagner'],
    streets: ['Hauptstrasse', 'Bahnhofstrasse', 'Gartenweg'],
    places: [
      { city: 'Berlin', postal: '10115' },
      { city: 'Munich', postal: '80331' },
      { city: 'Hamburg', postal: '20095' },
    ],
  },
  {
    code: 'JP', share: 2,
    first: ['Haruto', 'Yui', 'Sota', 'Aoi', 'Ren', 'Hina'],
    last: ['Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito'],
    streets: ['Chiyoda 1-chome', 'Umeda 2-chome'],
    places: [
      { city: 'Chiyoda-ku', state: 'Tokyo', postal: '100-0001' },
      { city: 'Kita-ku', state: 'Osaka', postal: '530-0001' },
    ],
  },
  {
    code: 'NL', share: 1,
    first: ['Daan', 'Emma', 'Sem', 'Julia'],
    last: ['de Jong', 'Jansen', 'de Vries', 'Bakker'],
    streets: ['Damrak', 'Coolsingel'],
    places: [
      { city: 'Amsterdam', postal: '1012 JS' },
      { city: 'Rotterdam', postal: '3011 AA' },
    ],
  },
  {
    code: 'FR', share: 1,
    first: ['Gabriel', 'Louise', 'Arthur', 'Jade'],
    last: ['Martin', 'Bernard', 'Dubois', 'Laurent'],
    streets: ['Rue de Rivoli', 'Rue de la Republique'],
    places: [
      { city: 'Paris', postal: '75001' },
      { city: 'Lyon', postal: '69001' },
    ],
  },
]

/** A second item often bought with the first: [companion, chance]. */
export const COMPANIONS = {
  'PHN-CASE': ['PHN-GLASS', 0.35],
  'HUB-7IN1': ['CAB-C2C', 0.3],
  'AUD-BUDS': ['AUD-CASE', 0.25],
  'DSK-ARM': ['DSK-CABLE', 0.3],
  'KEY-COMP': ['KEY-CAPS', 0.15],
  'PWR-10K': ['PHN-MOUNT', 0.15],
}

/**
 * Store events by date (inclusive): `orders` scales the day's order count,
 * `categories`/`skus` scale product weights (0 = not on sale that day).
 */
export const CALENDAR = [
  { label: 'Fall sale weekend', from: '2026-10-09', to: '2026-10-11', orders: 1.3 },
]
