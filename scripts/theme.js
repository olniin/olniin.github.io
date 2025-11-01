/* Theme selector */

const switchTheme = (theme) => {
  document.querySelector("body").setAttribute("class", theme);
  localStorage.setItem("theme", theme);
  const selectMenu2 = document.getElementById("themeMenu");
  if (theme=="light-dark") {
    selectMenu2.selectedIndex = 0;
  } else if (theme=="light") {
    selectMenu2.selectedIndex = 1;
  } else {
    selectMenu2.selectedIndex = 2;
  }
}

// theme menu interactibility
document.getElementById("themeMenu").addEventListener("change", (event2) => {
  switchTheme(event2.target.value);
});

// set default theme
if(!localStorage.getItem("theme")) {
  switchTheme("light-dark");
} else {
  switchTheme(localStorage.getItem("theme"));
}
