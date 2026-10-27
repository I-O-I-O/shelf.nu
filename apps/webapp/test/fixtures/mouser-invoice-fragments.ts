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

const repeatedMouserHeader = `Radnr
Line No.
Mousers Artikelnummer
Kundens/tillv. Artikelnr
Beskrivning
Ordered
Shipped
Pending
Price
Total`;

export const MOUSER_SIX_LINE_PAGES = [
  {
    sourceRef: "pdf-page-1",
    page: 1,
    text: `${repeatedMouserHeader}
1
713-100000001
Tillv. Artikelnr: 100000001
Arduino Uno R4 WiFi
5
3
2
41,02
123,06
${repeatedMouserHeader}
2
713-100000002
Tillv. Artikelnr: 100000002
Seeed Studio 24GHz mmWave Sensor
Avståndssensormoduler – öppen ram
4
4
0
41,02
164,08
3
713-100000003
Adafruit Feather RP2040
2
2
0
9,50
19,00
4
713-100000004
Tillv. Artikelnr:
BRD-100004
SparkFun Qwiic Connector Board
7
7
0
2,10
14,70
5
713-100000005
Tillv. Artikelnr: 100000005
Pololu 5V Step-Up Regulator
1
1
0
12,00
12,00
6
713-100000006
Tillv. Artikelnr: 100000006
Seeed Studio Grove Sensor Cable`,
  },
  {
    sourceRef: "pdf-page-2",
    page: 2,
    text: `Continued
${repeatedMouserHeader}
  2m, 4-pin
6
6
0
3,20
19,20
7
713-100000007
Tillv. Artikelnr: BROKEN-7
Unfinished product section
Price
Total
8
713-100000008
Pending-only connector
6
0
6
1,00
6,00`,
  },
] as const;

export const MOUSER_SIX_LINE_EXPECTED = [
  {
    supplierProductNumber: "713-100000001",
    mpn: "100000001",
    rawDescription: "Arduino Uno R4 WiFi",
    quantity: 3,
    sourcePage: 1,
  },
  {
    supplierProductNumber: "713-100000002",
    mpn: "100000002",
    rawDescription:
      "Seeed Studio 24GHz mmWave Sensor Avståndssensormoduler – öppen ram",
    quantity: 4,
    sourcePage: 1,
  },
  {
    supplierProductNumber: "713-100000003",
    mpn: null,
    rawDescription: "Adafruit Feather RP2040",
    quantity: 2,
    sourcePage: 1,
  },
  {
    supplierProductNumber: "713-100000004",
    mpn: "BRD-100004",
    rawDescription: "SparkFun Qwiic Connector Board",
    quantity: 7,
    sourcePage: 1,
  },
  {
    supplierProductNumber: "713-100000005",
    mpn: "100000005",
    rawDescription: "Pololu 5V Step-Up Regulator",
    quantity: 1,
    sourcePage: 1,
  },
  {
    supplierProductNumber: "713-100000006",
    mpn: "100000006",
    rawDescription: "Seeed Studio Grove Sensor Cable 2m, 4-pin",
    quantity: 6,
    sourcePage: 1,
  },
] as const;
