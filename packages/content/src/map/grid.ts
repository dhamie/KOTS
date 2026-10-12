/**
 * The city as a tile grid (x → east, y → south). Rendered isometrically by the client.
 * One character per tile: a territory code from TERRITORIES, `~` water, `=` bridge.
 * Stylised: real Lagos is the inspiration, not a survey. Edit freely; `npm test` validates the result.
 */
export const CITY_GRID: readonly string[] = [
  "~~TTTTTTTKKKKKKKKK~~~~~~~~~~~~~~~~~~~~~~",
  "~TTTTTTTTKKKKKKKKK~~~~~~~~~~~~~~~~~~~~~~",
  "TTTTTTTTTKKKKKKKKK~~~~~~~~~~~~~~~~~~~~~~",
  "TTTTTTTTTKKKKKKKKK=============~~~~~~~~~",
  "TTTTTTTTTKKKKKKKKK~~~~~~~~~~~~=~~~~~~~~~",
  "TTTTTTTTTKKKKKKKKK~~~~~~~~~~~~=~~~~~~~~~",
  "GGGGGGSSSSSSEEEEEE~~~~~~~~~~~~=~~~~~~~~~",
  "GGGGGGSSSSSSEEEEEE~~~~~~~~~~~~=~~~~~~~~~",
  "GGGGGGSSSSSSEEEEEE~~~~~~~~~~~~=~~~~~~~~~",
  "GGGGGGSSSSSSEEEEEE~~~~~~~~~~~~=~~~~~~~~~",
  "GGGGGGSSSSSSEEEEEE~~~~~~~~~~~~=~~~~~~~~~",
  "GGGGGGSSSSSSEEEEEE~~~~~~~~~~~~=~~~~~~~~~",
  "OOOOOOOMMMMMMMDDDD~~~~~RRRRRRRBBBBBB~~~~",
  "OOOOOOOMMMMMMMDDDD~~~~RRRRRRRRBBBBBBB~~~",
  "OOOOOOOMMMMMMMDDDD====RRRRRRRRBBBBBBBB~~",
  "OOOOOOOMMMMMMMDDDD~~~~RRRRRRRRBBBBBBBB~~",
  "OOOOOOOMMMMMMMDDDD~~~~IIIIIUUUUUUXXXXX~~",
  "OOOOOOOMMMMMMMDDDD~~~~IIIIIUUUUUUXXXXX~~",
  "~~~~~~~~~~~~~~JJJJ~~~~IIIIIUUUUUUXXXXX~~",
  "~ZZZZZZVVVVVVVJJJJ~~~~IIIIIUUUUUUXXXXX~~",
  "~ZZZZZZVVVVVVVJJJJ====IIIIIUUUUUUXXXXX~~",
  "ZZZZZZZVVVVVVVJJJJ~~~~IIIIIUUUUUUXXXXX~~",
  "ZZZZZZZPPPPPPWWWWW~~~~NNNNNNNQQQQQFFFF~~",
  "ZZZZZZZPPPPPPWWWWW~~~~NNNNNNNQQQQQFFFF~~",
  "ZZZZZZZPPPPPPWWWWW~~~~NNNNNNNQQQQQFFFF~~",
  "ZZZZZZZPPPPPPWWWWW~~~~NNNNNNNQQQQQFFFF~~",
  "YYYYYYCCCCCCCWWWWW~~~~NNNNNNNQQQQQFFF~~~",
  "YYYYYYCCCCCCCWWWWW~~~~~~NNNNNQQQQQFF~~~~",
  "~YYYYYCCCCCCCWWWWW~~~~~~~~~~~~~~~~~~~~~~",
  "~~YYYYCCCCCCCWWW~~~~~~~~~~~~~~~~~~~~~~~~",
  "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
  "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
];
