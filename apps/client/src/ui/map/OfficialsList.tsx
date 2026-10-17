import { canBeBought, CITY, OFFICE_DEFS, OFFICIAL_TRAIT_LABELS, OFFICIAL_TRAITS, OFFICIALS } from "@kots/content";

/** Each district's officials and their profiles (Phase 8b). Static content: nothing to load. */
export function OfficialsList() {
  return (
    <div className="officials" data-testid="officials">
      {[...CITY.districts.values()].map((d) => (
        <details key={d.slug}>
          <summary>{d.name}</summary>
          {OFFICIALS.filter((o) => o.district === d.slug).map((o) => (
            <article key={o.id} className="official" aria-label={o.name}>
              <div>
                <strong>{o.name}</strong> <span className="muted small">{OFFICE_DEFS[o.office].label}</span>
                {!canBeBought(o) && <span className="unbuyable small">Can't be bought</span>}
              </div>
              <p className="muted small">{o.bio}</p>
              <dl className="attributes">
                {OFFICIAL_TRAITS.map((t) => (
                  <div key={t}>
                    <dt>{OFFICIAL_TRAIT_LABELS[t]}</dt>
                    <dd>
                      <span className="bar" style={{ width: `${o.traits[t]}%` }} />
                      <span className="value">{o.traits[t]}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </details>
      ))}
    </div>
  );
}
