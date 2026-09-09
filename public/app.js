document.documentElement.classList.remove("no-js");

const header = document.getElementById("hdr");
const updateHeader = () => header.classList.toggle("solid", scrollY > 8);

updateHeader();
addEventListener("scroll", updateHeader, { passive: true });

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const status = document.getElementById(button.getAttribute("aria-describedby"));

    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
      status.textContent = "Command copied to the clipboard.";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1400);
    } catch {
      button.textContent = "Copy failed";
      status.textContent = "Copy failed. Select and copy the command manually.";
    }
  });
});

const names = [...document.querySelectorAll("[data-tool-name]")].map(
  (entry) => entry.dataset.toolName,
);
const rotations = ["rot2", "rot3", "rot4"]
  .map((id) => document.getElementById(id))
  .filter(Boolean);

if (rotations.length && names.length > 1) {
  const texts = rotations.map((node) => node.querySelector(".rot__t"));
  let index = 0;

  texts[0].addEventListener("animationiteration", () => {
    index = (index + 1) % names.length;
    texts.forEach((node) => {
      node.textContent = names[index];
    });
  });
  rotations.forEach((node) => node.classList.add("is-live"));
}
