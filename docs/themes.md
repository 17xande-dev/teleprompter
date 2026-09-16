# Viewer layouts and themes

Two layouts ship built in — **Clocks & Text** and **Big Clocks** — and the
**Viewer Layout** dropdown beside the preview switches every display at once.

Beyond those, **New Theme…** creates a layout you write yourself in plain CSS. A
theme starts as a copy of the default layout's rules, with the markup contract
commented at the top, and the dialog's editor pushes each change straight to the
preview _and_ to every connected display, so you style against the real thing
rather than guessing. Save keeps it; Cancel puts back whatever was on screen
before.

A theme **replaces** the built-in layout entirely — it is not layered on top —
so what you see is what your CSS says.

## The markup you are styling

```html
<header id="header" class="viewer-clocks">
  <tp-clock class="left" id="timeTimer" type="timer">…</tp-clock>
  <span class="mid" id="message"></span>
  <tp-clock class="right" id="timeClock" type="clock"></tp-clock>
</header>
<main id="main" class="content">…the script, or a column of .pdf-page…</main>
```

`tp-clock[type="timer"]` gains a `.negative` class once the countdown passes
zero, which is how the built-in layouts turn it red.

## The palette

Nine custom properties, declared on `:root` in `viewerBase.css`. The first two
are applied _there_, on the layer underneath every theme — so a theme that
overrides only those two recolours the screen without restating a layout, which
is the only reason a token is worth having:

| Property                 | Used for                   |
| ------------------------ | -------------------------- |
| `--viewer-bg`            | the page behind everything |
| `--viewer-color`         | the script                 |
| `--clocks-bg`            | the header strip           |
| `--clock-color`          | the wall clock             |
| `--timer-color`          | the countdown              |
| `--timer-negative-color` | the countdown past zero    |
| `--message-color`        | the message overlay        |
| `--viewer-gutter`        | the script's side margin   |
| `--viewer-block-gap`     | space between paragraphs   |

The five accents are read by the built-in layouts and by the template a new
theme starts from, so they follow a theme that keeps those rules and are taken
over by one that rewrites them.

`--viewer-gutter` is the odd one out: a length, not a colour, and applied in the
base layer like the first two. It keeps the script off the bezel — text read at
arm's length through glass loses its last character first, and that is the one
the talent is mid-sentence on. It is `max()` of a `rem` floor and a `cqi` term
so a phone in portrait still gets a usable margin while a large screen gets a
proportional one — a container unit rather than a viewport one, because every
display lays out in the stage and a `vi` here gave a 900-wide screen a narrower
gutter than the reference, so the two wrapped differently and stopped agreeing
on where a line was. PDF mode sets it aside: the page column measures the width
it is given, and a gutter there would render every page wider than the box it
has to fit in.

`--viewer-block-gap` is the other length, and it defaults to `0` rather than to
the browser's `1em`. At prompter font sizes 1em is a whole blank line: measured
on a real service script, 449 paragraphs at 48px spent about 21,000px of a
59,600px document on empty space, so a third of the operator's scrolling bought
no words. Headings keep their own larger font size, which is what separates them
now that the margin does not. Set it to something like `0.25em` to get air back
between every block at once — it is one dial on purpose, so a pasted document
whose mix of paragraphs and headings you cannot predict still comes out
consistent. The control page applies the same spacing to its editor, so what the
operator types breaks where the audience reads it breaking.

A display is white-on-black by default, and that lives in the base layer rather
than in a layout: a script is read off a screen at arm's length, often in a dark
room and often through glass at the talent's face, so a white page is a lamp
pointed at them.

## Three things stay out of your hands

- **The message's font size** is recalculated to fit its box.
- **`--textScale`** is the Text Scale slider.
- **The height and spacing of `.pdf-page`** is what makes a scroll position land
  on the same line on a phone and on a 4K display. Every dimension of a page
  box, the gap below it included, is set in pixels by JS and scales with the
  column; a `rem` gap declared in a theme would not, and displays of different
  sizes would drift apart by a little more with every page.

The editor warns you if a rule touches that last one — it is the one mistake
that produces no error at all, just a desync that grows. It also warns about
`@import`, which will not apply: a theme is installed as a constructed
stylesheet with no base URL. `url()` can only reach this server, per the page's
CSP.

Bad CSS is not rejected. A constructed stylesheet drops what it cannot parse and
keeps the rest, which is the behaviour you want mid-service — so the warnings
are advisory, aimed at the author, and nothing is blocked.

## Where they live

Themes live in the **control page's** browser storage, and the operator's
machine ships the CSS to each display over the same data channel as everything
else — so displays need no setup, and one that reloads mid-service comes back
wearing the right theme. Nothing is stored server-side yet; clearing that
browser's storage loses them. A theme's slug is minted once and never changes,
so renaming one cannot invalidate the class a connected display is already
wearing.
