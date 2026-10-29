// "Length 25 cm (10 in) · Mass 77 g" from a species_traits.json entry; length is the middle of its range.
export function sizeText({length_cm, mass_g} = {}) {
  const parts = [];
  if (length_cm) {
    const cm = (length_cm[0] + length_cm[1]) / 2;
    parts.push(`Length ${Math.round(cm)} cm (${Math.round(cm / 2.54)} in)`);
  }
  if (mass_g) parts.push(`Mass ${mass_g >= 1000 ? `${+(mass_g / 1000).toFixed(1)} kg` : `${mass_g < 10 ? +mass_g.toFixed(1) : Math.round(mass_g)} g`}`);
  return parts.join(" · ");
}
