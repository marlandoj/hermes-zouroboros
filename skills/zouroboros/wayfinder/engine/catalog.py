"""Skill catalog: SKILL.md frontmatter (name, description) from one or more roots.

Roots are scanned two levels deep so category layouts (root/category/skill/SKILL.md) work.
The first root to define a skill name wins, so list the canonical root first.

Default root: the hermes-zouroboros checkout's skills/ tree when this skill is installed
there, otherwise ~/.agents/skills. WAYFINDER_SKILLS_ROOTS (colon-separated) replaces it.
"""
import glob
import os
from pathlib import Path
import re

_SKILL_DIR = Path(__file__).resolve().parents[1]


def _distribution_root(skill_dir=_SKILL_DIR):
    """The checkout's skills/ tree when this skill ships as skills/<category>/wayfinder.

    The distribution uses the category layout skills/<category>/<skill>/SKILL.md, which
    load() covers by scanning two levels. Anywhere else there is no sibling catalog.
    """
    root = skill_dir.parents[1]
    if root.name == 'skills' and (skill_dir / 'SKILL.md').is_file():
        return str(root)
    return None


DEFAULT_ROOTS = [_distribution_root() or '~/.agents/skills']


# Skills each harness already loads natively. Opt-in (WAYFINDER_NATIVE_SKILLS=1): the harness
# advertises these itself, and adding them can displace better shared-catalog picks.
# For Hermes the profile dir is searched first, because Hermes gives the profile's own
# skills precedence over skills.external_dirs when names collide.
NATIVE_ROOTS = {
    'claude': ['~/.claude/skills'],
    'codex': ['~/.codex/skills', '~/.agents/skills'],
    'kimi': ['~/.kimi-code/skills', '~/.agents/skills'],
    'gemini': ['~/.gemini/skills', '~/.agents/skills'],
    'opencode': ['~/.config/opencode/skills', '~/.claude/skills', '~/.agents/skills'],
    'pi': ['~/.pi/agent/skills'],
    'hermes': [],
}


def frontmatter_value(block, key):
    match = re.search(r'^' + key + r':\s*(?:[>|][-+]?\s*\n)?(.+?)(?=\n[A-Za-z_-]+:|\Z)', block, re.M | re.S)
    return re.sub(r'\s+', ' ', match.group(1)).strip().strip('"\'') if match else None


def roots_for(harness=None, env=None):
    env = os.environ if env is None else env
    roots = [r for r in (env.get('WAYFINDER_SKILLS_ROOTS') or '').split(':') if r.strip()] or list(DEFAULT_ROOTS)
    if harness and env.get('WAYFINDER_NATIVE_SKILLS', '0') == '1':
        if harness == 'hermes':  # the profile's own skills: $HERMES_HOME/skills, else ~/.hermes/skills
            roots = [str(Path(env.get('HERMES_HOME') or '~/.hermes') / 'skills')] + roots
        roots += NATIVE_ROOTS.get(harness, [])
    return [os.path.expanduser(r) for r in roots]


def load(roots):
    items, seen = [], set()
    for root in roots:
        paths = sorted(glob.glob(str(Path(root) / '*' / 'SKILL.md')) + glob.glob(str(Path(root) / '*' / '*' / 'SKILL.md')))
        for path in paths:
            if '/_' in path[len(str(root)):] or '/node_modules/' in path:
                continue
            try:
                text = Path(path).read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            match = re.match(r'---\n(.*?)\n---', text, re.S)
            if not match:
                continue
            name, description = frontmatter_value(match.group(1), 'name'), frontmatter_value(match.group(1), 'description')
            if name and description and name not in seen:
                seen.add(name)
                items.append({'id': name, 'description': description, 'source': path})
    return items
