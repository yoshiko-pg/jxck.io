#!/usr/bin/ruby

require "time"

# html special chars
def hsc(str)
  str.gsub(/&/, "&amp;")
     .gsub(/</, "&lt;")
     .gsub(/>/, "&gt;")
     .gsub(/"/, "&quot;")
     .gsub(/'/, "&#039;")
end

class Article
  attr_reader :path

  def initialize(path)
    @path = path
    @text = File.read(path)
  end

  def title
    hsc @text.match(/^# \[.*\] (.*)/)[1]
  end

  def url
    path.sub('./', 'https://').sub('.md', '.html')
  end

  def summary
    hsc @text.match(/## Theme(.*?)##/im)[1].strip.split("\n")[0]
  end

  def to_s
    @path
  end
end

class Entry < Article
  def href
    url
  end

  def summary
    # TODO
    hsc @text.match(/## intro(.*?)##/im)[1].strip
  end

  def updated
    date = @path.split("/")[3]
    updated  = "#{date}T00:00:00Z"
  end

  def id
    date = @path.split("/")[3]
    "tag:blog.jxck.io,2016:entry://#{date}"
  end

  def entry
    <<-EOS
  <entry>
   <title>#{title}</title>
   <link href="#{href}" rel="alternate" />
   <id>#{id}</id>
   <updated>#{updated}</updated>
   <summary>#{summary}</summary>
  </entry>
    EOS
  end

  def json
    {
      title:   title,
      href:    href,
      id:      id,
      updated: updated,
      summary: summary
    }
  end

  def <=>(target)
    return path <=> target.path
  end

end

class Episode < Article
  attr_accessor :order

  def num
    @path.split('/')[3].to_i
  end

  def subtitle
    summary
  end

  def sideshow?
    !! (@path =~ /.*sideshow.md/)
  end

  def pubDate
    datetime = @text.match(/datetime=(.*?)>/)[1]
    Time.parse(datetime).rfc822
  end

  def description
    hsc @text.sub(/#(.*?)## Theme/m, "# #{title}").gsub(/\[(.*?)\]\(.*?\)/, '\1')
  end

  def file
    "files.mozaic.fm/mozaic-ep#{num}#{'.sideshow' if sideshow?}.mp3"
  end

  def size
    File.open("../#{file}").size
  end

  def duration
    sec = 0
    if RUBY_PLATFORM.match(/darwin/)
      sec = `afinfo ../#{file}  | grep duration | cut -d' ' -f 3`.to_i
    else
      sec = `mp3info -p "%S\n" ../#{file}`.to_i
    end
    Time.at(sec).utc.strftime("%X")
  end

  def to_s
    "#{summary}"
  end

  def <=>(target)
    if num == target.num
      return sideshow? ? 1: -1
    end
    return num <=> target.num
  end

  def item
    <<-EOS
       <item>
         <category>mozaicfm</category>
         <enclosure url="http://#{file}" length="#{size}" type="audio/mpeg" />
         <guid isPermaLink="false">#{url}</guid>
         <link>#{url}</link>
         <pubDate>#{pubDate}</pubDate>
         <title>#{title} | mozaic.fm</title>
         <itunes:author>Jxck</itunes:author>
         <itunes:duration>#{duration}</itunes:duration>
         <itunes:explicit>no</itunes:explicit>
         <itunes:keywords>web,tech,it</itunes:keywords>
         <itunes:order>#{order}</itunes:order>
         <itunes:subtitle>#{subtitle}</itunes:subtitle>
         <media:content url="https://#{file}" fileSize="#{size}" type="audio/mpeg" />
         <description>#{description}</description>
       </item>
    EOS
  end
end

def atom(dir)
  entries = Dir.glob(dir)
    .select { |path| path.match(/.*.md\z/) }
    .map { |path| Entry.new(path) }
    .sort
    .reverse
    .map {|e| e.entry }
    .join("")

  <<-EOS
<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom' xml:lang='ja'>
<title>blog.jxck.io</title>
<link rel="alternate" href="https://blog.jxck.io/"/>
<link rel="self" type="application/atom+xml" href="https://blog.jxck.io/feeds/atom.xml"/>
<author><name>Jxck</name></author>
<id>tag:blog.jxck.io,2016:feed</id>
<updated>2016-01-28T18:30:02Z</updated>
#{entries}
</feed>
  EOS
end

def json(dir)
  require "json"
  entries = Dir.glob(dir)
    .select { |path| path.match(/.*.md\z/) }
    .map { |path| Entry.new(path) }
    .sort
    .reverse
    .map {|e| e.json}

  JSON.pretty_generate(
    title:     "blog.jxck.io",
    alternate: "https://blog.jxck.io",
    author:    { name: "Jxck" },
    id:        "tag:blog.jxck.io,2016:feed",
    update:    "2016-01-28T18:30:02Z",
    entry:     entries
  )
end

def rss2(dir)
  items = Dir.glob(dir)
    .select {|path| path.match(/.*.md\z/) }
    .map {|path| Episode.new(path) }
    .sort
    .reverse
    .map.with_index {|ep, i|
      ep.order = i
      ep.item
    }
    .join("")

  <<-EOS
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/" >
  <channel>
    <title>mozaic.fm</title>
    <link>http://mozaic.fm/</link>
    <description>next generation web podcast</description>
    <generator>Ruby</generator>
    <language>ja</language>
    <copyright>Copyright (c) 2014 mozaic.fm. All Rights Reserved. Redistribute, Transcript are not allowed.</copyright>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" rel="self" type="application/rss+xml" href="https://podcast.jxck.io/feeds/feed.xml" />
    <itunes:author>Jxck</itunes:author>
    <itunes:category text="Technology"><itunes:category text="Podcasting" /></itunes:category>
    <itunes:explicit>no</itunes:explicit>
    <itunes:image href="http://files.mozaic.fm/mozaic.png" />
    <itunes:keywords>web,technology,programming,it,software,jxck</itunes:keywords>
    <itunes:subtitle>next generation web podcast</itunes:subtitle>
    <itunes:summary>talking about next generation web technologies hosted by Jxck </itunes:summary>
    <media:category scheme="http://www.itunes.com/dtds/podcast-1.0.dtd">Technology/Podcasting</media:category>
    <media:copyright>Copyright (c) 2014 mozaic.fm. All Rights Reserved. Redistribute, Transcript are not allowed.</media:copyright>
    <media:credit role="author">Jxck</media:credit>
    <media:description type="plain">next generation web podcast</media:description>
    <media:keywords>web,technology,programming,it,software,jxck</media:keywords>
    <media:rating>nonadult</media:rating>
    <media:thumbnail url="http://files.mozaic.fm/mozaic.png" />
    <itunes:owner>
      <itunes:email>block.rxckin.beats@gmail.com</itunes:email>
      <itunes:name>Jxck</itunes:name>
    </itunes:owner>
#{items}
  </channel>
</rss>
  EOS
end

if __FILE__ == $0
  File.write("./blog.jxck.io/feeds/atom.xml", atom("./blog.jxck.io/entries/**/*"))
  File.write("./blog.jxck.io/feeds/atom.json", json("./blog.jxck.io/entries/**/*"))
  File.write("./podcast.jxck.io/feeds/feed.xml", rss2("./podcast.jxck.io/**/*"))

end
