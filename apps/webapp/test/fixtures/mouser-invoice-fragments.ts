export const MOUSER_FRAGMENTED_PAGE_TEXT = `Radnr
Line No.
Mousers Artikelnummer
Kundens/tillv. Artikelnr
Beskrivning
Ordered
Shipped
Pending
Price
Total
713-114993388
Tillv. Artikelnr: 114993388
Seeed Studio Seeed Studio 60GHz mmWave Sensor
1
1
0
260,76
260,76
Radnr
Line No.
Mousers Artikelnummer
Kundens/tillv. Artikelnr
Beskrivning
Ordered
Shipped
Pending
Price
Total
713-101010001
Tillv. Artikelnr: 101010001
Seeed Studio 24GHz mmWave Sensor / Avståndssensormoduler – öppen ram
4
4
0
41,02
164,08`;

export const MOUSER_FRAGMENTED_EXPECTED_ROWS = [
  {
    supplierProductNumber: "713-114993388",
    mpn: "114993388",
    productName: "Seeed Studio 60GHz mmWave Sensor",
    manufacturer: "Seeed Studio",
    quantity: 1,
  },
  {
    supplierProductNumber: "713-101010001",
    mpn: "101010001",
    productName:
      "Seeed Studio 24GHz mmWave Sensor / Avståndssensormoduler – öppen ram",
    manufacturer: "Seeed Studio",
    quantity: 4,
  },
] as const;
