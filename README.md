# 015Kerstmarkt app

Mini-app voor de 015Connect Kerstmarkt: plattegrond, de tiener-todo en "Mijn kerstmarkt-POV" (foto's en filmpjes).

Verzamel & verdien: wie bij 7 verschillende onderdelen een POV verstuurt, verdient 2 limited-edition 015Kerstkaarten (de tiener laat het scherm zien aan het team). Elke foto of film is daarnaast één lot voor de 015Connect-hoodie.

- `index.html` is de app voor bezoekers.
- `beheer.html` is voor het team: fotomuur voor een scherm, alle foto's, de hoodieloting en een QR-poster. Hiervoor is de beheersleutel nodig.

Teksten, onderdelen, programma, links en pinnen op de kaart pas je aan in het blok `CONFIG` bovenaan het script in `index.html`. Sfeerfoto's, de plattegrond en de jaarplanning staan in `assets/`.

Testen: `#wis` achter het adres toont een knop die alles op dat toestel wist. `#pinnen` laat x/y zien als je op de kaart tikt.

Foto's en filmpjes komen via een kleine uploadserver (Cloudflare Worker) in een privé-repo terecht; ze staan niet in deze openbare repo.
